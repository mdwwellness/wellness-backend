import { describe, it, expect, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import {
  CUSTOMER_TOKEN_TTL_SECONDS,
  signCustomerToken,
  verifyCustomerToken,
} from "./customerToken.ts";

const CUSTOMER_SECRET = "customer-secret-0123456789abcdef-xyz";
const STAFF_SECRET = "staff-secret";
const ACCOUNT_ID = "64b7f0c2a1b2c3d4e5f60718";
const INVALID = { ok: false, expired: false };

const original = {
  JWT_SECRET: process.env.JWT_SECRET,
  CUSTOMER_JWT_SECRET: process.env.CUSTOMER_JWT_SECRET,
};

function restore(name: keyof typeof original) {
  if (original[name] === undefined) delete process.env[name];
  else process.env[name] = original[name];
}

beforeEach(() => {
  process.env.JWT_SECRET = STAFF_SECRET;
  process.env.CUSTOMER_JWT_SECRET = CUSTOMER_SECRET;
});

afterEach(() => {
  restore("JWT_SECRET");
  restore("CUSTOMER_JWT_SECRET");
});

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("signCustomerToken", () => {
  it("issues an HS256 token { sub, typ: customer } that expires in 7 days", () => {
    const token = signCustomerToken(ACCOUNT_ID);
    const decoded = jwt.decode(token, { complete: true })!;
    const payload = decoded.payload as jwt.JwtPayload;

    expect(decoded.header.alg).toBe("HS256");
    expect(payload.sub).toBe(ACCOUNT_ID);
    expect(payload.typ).toBe("customer");
    expect(payload.exp! - payload.iat!).toBe(CUSTOMER_TOKEN_TTL_SECONDS);
    expect(CUSTOMER_TOKEN_TTL_SECONDS).toBe(604800);
  });

  it("refuses to sign without a usable secret", () => {
    delete process.env.CUSTOMER_JWT_SECRET;
    expect(() => signCustomerToken(ACCOUNT_ID)).toThrow(/CUSTOMER_JWT_SECRET/);
    process.env.CUSTOMER_JWT_SECRET = STAFF_SECRET.padEnd(40, "x");
    process.env.JWT_SECRET = process.env.CUSTOMER_JWT_SECRET;
    expect(() => signCustomerToken(ACCOUNT_ID)).toThrow(/CUSTOMER_JWT_SECRET/);
  });
});

describe("verifyCustomerToken", () => {
  it("accepts a token it issued", () => {
    expect(verifyCustomerToken(signCustomerToken(ACCOUNT_ID))).toEqual({
      ok: true,
      accountId: ACCOUNT_ID,
    });
  });

  it("rejects a staff token signed with JWT_SECRET", () => {
    const staff = jwt.sign({ id: ACCOUNT_ID }, STAFF_SECRET, { expiresIn: "1h" });
    expect(verifyCustomerToken(staff)).toEqual(INVALID);
  });

  it("rejects a staff-shaped payload even if it carried the customer signature", () => {
    const staffShaped = jwt.sign({ id: ACCOUNT_ID }, CUSTOMER_SECRET, { expiresIn: "1h" });
    expect(verifyCustomerToken(staffShaped)).toEqual(INVALID);
  });

  it("rejects a token whose typ is not customer", () => {
    const other = jwt.sign({ sub: ACCOUNT_ID, typ: "staff" }, CUSTOMER_SECRET, { expiresIn: "1h" });
    expect(verifyCustomerToken(other)).toEqual(INVALID);
  });

  it("rejects a sub that is missing, empty or not a string", () => {
    for (const sub of [undefined, "", 42, { $ne: null }, [ACCOUNT_ID]]) {
      const token = jwt.sign({ sub, typ: "customer" } as object, CUSTOMER_SECRET, {
        expiresIn: "1h",
      });
      expect(verifyCustomerToken(token)).toEqual(INVALID);
    }
  });

  it("leaves a malformed string sub to the account lookup, which finds nothing (401)", () => {
    const token = jwt.sign({ sub: "not-an-id", typ: "customer" }, CUSTOMER_SECRET, { expiresIn: "1h" });
    expect(verifyCustomerToken(token)).toEqual({ ok: true, accountId: "not-an-id" });
  });

  it("rejects a tampered payload", () => {
    const [header, , signature] = signCustomerToken(ACCOUNT_ID).split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ sub: "ffffffffffffffffffffffff", typ: "customer", exp: nowSeconds() + 3600 }),
    ).toString("base64url");
    expect(verifyCustomerToken(`${header}.${forgedBody}.${signature}`)).toEqual(INVALID);
  });

  it("rejects an unsigned alg:none token", () => {
    const unsigned = jwt.sign({ sub: ACCOUNT_ID, typ: "customer" }, "", { algorithm: "none" });
    expect(verifyCustomerToken(unsigned)).toEqual(INVALID);
  });

  it("rejects another HMAC algorithm, even with the right secret", () => {
    const hs512 = jwt.sign({ sub: ACCOUNT_ID, typ: "customer" }, CUSTOMER_SECRET, {
      algorithm: "HS512",
      expiresIn: "1h",
    });
    expect(verifyCustomerToken(hs512)).toEqual(INVALID);
  });

  it("reports expiry separately so the app can ask the customer to sign in again", () => {
    const expired = jwt.sign(
      { sub: ACCOUNT_ID, typ: "customer", exp: nowSeconds() - 10 },
      CUSTOMER_SECRET,
    );
    expect(verifyCustomerToken(expired)).toEqual({ ok: false, expired: true });
  });

  it("does not report expiry for an expired token with a bad signature", () => {
    const expiredForeign = jwt.sign(
      { sub: ACCOUNT_ID, typ: "customer", exp: nowSeconds() - 10 },
      STAFF_SECRET,
    );
    expect(verifyCustomerToken(expiredForeign)).toEqual(INVALID);
  });

  it("rejects garbage", () => {
    for (const token of ["", "abc", "a.b.c"]) expect(verifyCustomerToken(token)).toEqual(INVALID);
  });

  it("fails closed when the secret is not configured", () => {
    const token = signCustomerToken(ACCOUNT_ID);
    delete process.env.CUSTOMER_JWT_SECRET;
    expect(verifyCustomerToken(token)).toEqual(INVALID);
  });
});
