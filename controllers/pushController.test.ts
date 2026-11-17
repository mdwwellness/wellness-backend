import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const m = vi.hoisted(() => ({ updateOne: vi.fn(), deleteOne: vi.fn() }));
vi.mock("../models/pushSubscriptionModel.ts", () => ({
  PushSubscription: { updateOne: m.updateOne, deleteOne: m.deleteOne },
}));
vi.mock("../models/userModel.ts", () => ({ default: {} }));
vi.mock("../models/doctorsModel.ts", () => ({ Doctor: {} }));

import { getPushKey, removeSubscription, saveSubscription } from "./pushController.ts";

function res() {
  const r: any = {};
  r.status = vi.fn().mockReturnValue(r);
  r.send = vi.fn().mockReturnValue(r);
  return r as Response & { status: any; send: any };
}
const req = (body: unknown) => ({ body, user: { _id: "u1", role: "STAFF" } }) as unknown as Request;
const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "BPkey", auth: "authkey" } };

beforeEach(() => vi.clearAllMocks());

describe("POST /api/push/subscriptions", () => {
  it("saves this browser for the logged-in user, moving it if another user had it", async () => {
    const r = res();
    await saveSubscription(req({ ...sub, userId: "someone-else" }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(m.updateOne).toHaveBeenCalledWith(
      { endpoint: sub.endpoint },
      { $set: { keys: { p256dh: "BPkey", auth: "authkey" }, userId: "u1" } },
      { upsert: true },
    );
  });

  it.each([
    ["an address that isn't a push service", { ...sub, endpoint: "https://attacker.example/hook" }],
    ["plain http", { ...sub, endpoint: "http://fcm.googleapis.com/fcm/send/abc" }],
    ["missing keys", { endpoint: sub.endpoint }],
    ["an oversized key", { ...sub, keys: { p256dh: "x".repeat(201), auth: "a" } }],
    ["no body", undefined],
  ])("refuses %s", async (_why, body) => {
    const r = res();
    await saveSubscription(req(body), r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(m.updateOne).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/push/subscriptions", () => {
  it("removes only this user's own device", async () => {
    const r = res();
    await removeSubscription(req({ endpoint: sub.endpoint }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(m.deleteOne).toHaveBeenCalledWith({ endpoint: sub.endpoint, userId: "u1" });
  });
});

describe("GET /api/push/key", () => {
  it("gives the public key, or empty when alerts aren't set up", () => {
    process.env.VAPID_PUBLIC_KEY = "BPub";
    const r = res();
    getPushKey(req({}), r);
    expect(r.send).toHaveBeenCalledWith({ success: true, message: "OK", data: "BPub" });
    delete process.env.VAPID_PUBLIC_KEY;
    const r2 = res();
    getPushKey(req({}), r2);
    expect(r2.send.mock.calls[0][0].data).toBe("");
  });
});
