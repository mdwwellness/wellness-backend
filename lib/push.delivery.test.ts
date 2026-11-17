import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import https from "node:https";
import { EventEmitter } from "node:events";
import webpush from "web-push";
// @ts-expect-error http_ece (web-push's own encryption library) ships no types
import ece from "http_ece";

/**
 * The real web-push library end to end, with no network: the request it would
 * send to Google's push service is caught, then checked the way a phone and the
 * push service would check it: decrypted with the phone's keys, and its VAPID
 * signature verified with our public key.
 */

const m = vi.hoisted(() => ({ subs: [] as any[], subDelete: vi.fn() }));
vi.mock("../models/userModel.ts", () => ({
  default: { find: () => ({ lean: async () => [{ _id: "6650000000000000000000b1" }] }) },
}));
vi.mock("../models/doctorsModel.ts", () => ({
  Doctor: { findOne: () => ({ lean: async () => ({ doctorId: "THR-0004", userId: "6650000000000000000000b1" }) }) },
}));
vi.mock("../models/pushSubscriptionModel.ts", () => ({
  PushSubscription: { find: () => ({ lean: async () => m.subs }), deleteOne: m.subDelete },
}));
vi.mock("./logger.ts", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { notifyAssigned, therapistAlert } from "./push.ts";

const b64url = (b: Buffer) => b.toString("base64url");
let sent: { options: any; body: Buffer }[];
let status: number;

beforeEach(() => {
  const vapid = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
  delete process.env.VAPID_SUBJECT;
  sent = [];
  status = 201;
  vi.spyOn(https, "request").mockImplementation(((options: any, onResponse: any) => {
    const req: any = new EventEmitter();
    const chunks: Buffer[] = [];
    req.write = (c: Buffer) => chunks.push(Buffer.from(c));
    req.end = () => {
      sent.push({ options, body: Buffer.concat(chunks) });
      const res: any = new EventEmitter();
      res.statusCode = status;
      onResponse(res);
      res.emit("end");
    };
    return req;
  }) as any);
});
afterEach(() => vi.restoreAllMocks());

/** A phone's subscription: its own key pair and auth secret, as Chrome makes them. */
function phone() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = {
    endpoint: "https://fcm.googleapis.com/fcm/send/phone-token",
    keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) },
    userId: "6650000000000000000000b1",
  };
  return { ecdh, auth, sub };
}

const booking = { _id: "b1", name: "Ravi", doctorId: "THR-0004", slot: { date: "2026-11-14", time: "11:30" } };

describe("a phone alert as the push service and the phone receive it", () => {
  it("is posted to the phone's push address, decrypts to the alert, and carries a valid VAPID signature", async () => {
    const p = phone();
    m.subs = [p.sub];
    await notifyAssigned(booking);

    expect(sent).toHaveLength(1);
    const { options, body } = sent[0];
    expect(options).toMatchObject({ hostname: "fcm.googleapis.com", path: "/fcm/send/phone-token", method: "POST" });
    expect(options.headers).toMatchObject({ "Content-Encoding": "aes128gcm", TTL: 86400, Urgency: "high" });

    // The phone decrypts it with its private key and auth secret.
    const plain = ece.decrypt(body, { version: "aes128gcm", privateKey: p.ecdh, authSecret: p.auth });
    expect(JSON.parse(plain.toString())).toEqual(therapistAlert(booking));

    // The push service checks the VAPID token against our public key.
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(options.headers.Authorization)!;
    expect(key).toBe(process.env.VAPID_PUBLIC_KEY);
    const [h, payload, sig] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "https://dashboard.wellness.mydawaiwala.com" });
    const raw = Buffer.from(key, "base64url"); // 0x04 | x | y
    const publicKey = crypto.createPublicKey({
      key: { kty: "EC", crv: "P-256", x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33)) },
      format: "jwk",
    });
    const valid = crypto.verify("sha256", Buffer.from(`${h}.${payload}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
    expect(valid).toBe(true);
  });

  it("a phone the push service no longer knows (410) is removed", async () => {
    const p = phone();
    m.subs = [p.sub];
    status = 410;
    await notifyAssigned(booking);
    expect(m.subDelete).toHaveBeenCalledWith({ endpoint: p.sub.endpoint });
  });
});
