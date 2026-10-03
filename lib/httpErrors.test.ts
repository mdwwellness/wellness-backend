import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("./logger.ts", () => ({ logger }));

import { clientErrorStatus, errorHandler, redactDigits } from "./httpErrors.ts";

const thrower = (err: unknown) => () => {
  throw err;
};

// Real middleware errors (body-parser) through the real handler, over HTTP.
describe("errorHandler", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.post("/json", express.json({ limit: "50b" }), (_req, res) => {
      res.json({ ok: true });
    });
    // What server.ts's CORS callback rejects with.
    app.get("/cors", thrower(Object.assign(new Error("Origin not allowed"), { status: 403, expose: true })));
    app.get("/hidden", thrower(Object.assign(new Error("token secret mismatch"), { status: 401 })));
    app.get("/upstream", thrower(Object.assign(new Error("bad gateway"), { status: 502, expose: true })));
    app.get(
      "/dup",
      thrower(
        new Error(
          'E11000 duplicate key error collection: mdw.users index: phoneE164_1 dup key: { phoneE164: "+919876543210" }',
        ),
      ),
    );
    app.get("/plain", thrower({ code: "X", phone: 9876543210 }));
    app.use(errorHandler);
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  beforeEach(() => vi.clearAllMocks());

  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: await res.json() };
  };

  const postJson = async (body: string) => {
    const res = await fetch(`${base}/json`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    return { status: res.status, body: await res.json() };
  };

  it("answers a CORS rejection 403 with its message", async () => {
    expect(await get("/cors")).toEqual({
      status: 403,
      body: { success: false, message: "Origin not allowed" },
    });
  });

  it("keeps body-parser's 400 and 413, and never logs the body", async () => {
    const bad = await postJson('{"phone":"9876543210","otp":');
    expect(bad.status).toBe(400);
    expect(bad.body.success).toBe(false);

    const big = await postJson(JSON.stringify({ note: "x".repeat(100) }));
    expect(big).toEqual({ status: 413, body: { success: false, message: "request entity too large" } });

    expect(logger.warn.mock.calls).toEqual([["POST /json → 400"], ["POST /json → 413"]]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("hides the message of a 4xx that isn't marked expose", async () => {
    expect(await get("/hidden")).toEqual({
      status: 401,
      body: { success: false, message: "Request rejected" },
    });
  });

  it("answers anything else 500 and logs it, 5xx statuses included", async () => {
    expect(await get("/upstream")).toEqual({ status: 500, body: { success: false, message: "Server error" } });
    expect(logger.error).toHaveBeenCalledWith("Unhandled error on GET /upstream", expect.stringContaining("bad gateway"));
  });

  it("masks phone numbers in what it logs", async () => {
    expect((await get("/dup")).status).toBe(500);
    expect((await get("/plain")).status).toBe(500);
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).not.toContain("9876543210");
    expect(logged).toContain('phoneE164: \\"+******3210\\"');
    expect(logged).toContain("phone: ******3210");
  });
});

describe("clientErrorStatus", () => {
  it("returns only integer 4xx statuses, from status or statusCode", () => {
    expect(clientErrorStatus({ status: 404 })).toBe(404);
    expect(clientErrorStatus({ statusCode: 429 })).toBe(429);
    for (const err of [{ status: 500 }, { status: 399 }, { status: "400" }, null, undefined, new Error("x")]) {
      expect(clientErrorStatus(err)).toBeNull();
    }
  });
});

describe("redactDigits", () => {
  it("masks runs of 10+ digits and leaves shorter numbers alone", () => {
    expect(redactDigits("phone 9876543210 at line 1234567")).toBe("phone ******3210 at line 1234567");
    expect(redactDigits("+919876543210")).toBe("+******3210");
  });
});
