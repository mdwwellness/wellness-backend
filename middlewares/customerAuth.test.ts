import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

const { mockFindAccountById } = vi.hoisted(() => ({ mockFindAccountById: vi.fn() }));
vi.mock("../lib/customerAccount.ts", () => ({ findAccountById: mockFindAccountById }));

import customerAuth from "./customerAuth.ts";
import { signCustomerToken } from "../lib/customerToken.ts";

const CUSTOMER_SECRET = "customer-secret-0123456789abcdef-xyz";
const STAFF_SECRET = "staff-secret";
const ACCOUNT_ID = "64b7f0c2a1b2c3d4e5f60718";
const INVALID = { success: false, message: "Invalid or expired session." };

const original = {
  JWT_SECRET: process.env.JWT_SECRET,
  CUSTOMER_JWT_SECRET: process.env.CUSTOMER_JWT_SECRET,
};

function restore(name: keyof typeof original) {
  if (original[name] === undefined) delete process.env[name];
  else process.env[name] = original[name];
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    _id: ACCOUNT_ID,
    phoneE164: "+919876543210",
    roles: ["customer"],
    status: "active",
    products: ["wellness"],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function mockReq(headers: Record<string, string> = {}, cookies: Record<string, string> = {}) {
  return { headers, cookies } as unknown as Request;
}

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

async function run(req: Request) {
  const res = mockRes();
  const next = vi.fn() as unknown as NextFunction;
  await customerAuth(req, res, next);
  return { res, next };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = STAFF_SECRET;
  process.env.CUSTOMER_JWT_SECRET = CUSTOMER_SECRET;
});

afterEach(() => {
  restore("JWT_SECRET");
  restore("CUSTOMER_JWT_SECRET");
});

describe("customerAuth", () => {
  it("401s with 'Sign in required.' when there is no Authorization header", async () => {
    const { res, next } = await run(mockReq());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: "Sign in required." });
    expect(next).not.toHaveBeenCalled();
  });

  it("ignores a valid customer token sent only as a cookie", async () => {
    const token = signCustomerToken(ACCOUNT_ID);
    const { res, next } = await run(mockReq({}, { accessToken: token, token }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: "Sign in required." });
    expect(mockFindAccountById).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("ignores a non-Bearer scheme", async () => {
    const token = signCustomerToken(ACCOUNT_ID);
    const { res } = await run(mockReq({ authorization: `Basic ${token}` }));
    expect(res.json).toHaveBeenCalledWith({ success: false, message: "Sign in required." });
  });

  it("rejects a staff token", async () => {
    const staff = jwt.sign({ id: ACCOUNT_ID }, STAFF_SECRET, { expiresIn: "1h" });
    const { res, next } = await run(mockReq(bearer(staff)));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(INVALID);
    expect(mockFindAccountById).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a tampered token", async () => {
    const token = signCustomerToken(ACCOUNT_ID);
    const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    const { res, next } = await run(mockReq(bearer(tampered)));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(INVALID);
    expect(next).not.toHaveBeenCalled();
  });

  it("flags an expired token with code TOKEN_EXPIRED", async () => {
    const expired = jwt.sign(
      { sub: ACCOUNT_ID, typ: "customer", exp: Math.floor(Date.now() / 1000) - 10 },
      CUSTOMER_SECRET,
    );
    const { res, next } = await run(mockReq(bearer(expired)));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ ...INVALID, code: "TOKEN_EXPIRED" });
    expect(next).not.toHaveBeenCalled();
  });

  it("401s when the account no longer exists", async () => {
    mockFindAccountById.mockResolvedValue(null);
    const { res, next } = await run(mockReq(bearer(signCustomerToken(ACCOUNT_ID))));
    expect(mockFindAccountById).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(INVALID);
    expect(next).not.toHaveBeenCalled();
  });

  it("403s a blocked account even with a valid token", async () => {
    mockFindAccountById.mockResolvedValue(account({ status: "blocked" }));
    const { res, next } = await run(mockReq(bearer(signCustomerToken(ACCOUNT_ID))));
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: "This account is blocked." });
    expect(next).not.toHaveBeenCalled();
  });

  it("403s an account not tagged for wellness", async () => {
    for (const products of [undefined, [], ["pharmacy"]]) {
      mockFindAccountById.mockResolvedValue(account({ products }));
      const { res, next } = await run(mockReq(bearer(signCustomerToken(ACCOUNT_ID))));
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "This account isn't registered for MDW Wellness.",
      });
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("sets req.customerAccount and calls next for an active wellness account", async () => {
    const acct = account({ products: ["pharmacy", "wellness"] });
    mockFindAccountById.mockResolvedValue(acct);
    const req = mockReq(bearer(signCustomerToken(ACCOUNT_ID)));
    const { res, next } = await run(req);
    expect(req.customerAccount).toBe(acct);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("lets a database error propagate (500) instead of signing the customer out", async () => {
    mockFindAccountById.mockRejectedValue(new Error("db down"));
    await expect(run(mockReq(bearer(signCustomerToken(ACCOUNT_ID))))).rejects.toThrow("db down");
  });
});
