import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertJwtSecrets, customerJwtSecret, jwtRefreshSecret, jwtSecret } from "./env.ts";

const original = {
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  CUSTOMER_JWT_SECRET: process.env.CUSTOMER_JWT_SECRET,
};

beforeEach(() => {
  process.env.JWT_SECRET = "test-access-secret";
  process.env.JWT_REFRESH_SECRET = "test-refresh-secret";
});

afterEach(() => {
  process.env.JWT_SECRET = original.JWT_SECRET;
  process.env.JWT_REFRESH_SECRET = original.JWT_REFRESH_SECRET;
  // Assigning undefined to process.env stores the string "undefined".
  if (original.CUSTOMER_JWT_SECRET === undefined) delete process.env.CUSTOMER_JWT_SECRET;
  else process.env.CUSTOMER_JWT_SECRET = original.CUSTOMER_JWT_SECRET;
});

describe("jwt secrets", () => {
  it("returns the configured secrets", () => {
    expect(jwtSecret()).toBe("test-access-secret");
    expect(jwtRefreshSecret()).toBe("test-refresh-secret");
  });

  it("throws rather than falling back when the access secret is missing", () => {
    delete process.env.JWT_SECRET;
    expect(() => jwtSecret()).toThrow(/JWT_SECRET is not set/);
  });

  it("throws rather than falling back when the refresh secret is missing", () => {
    delete process.env.JWT_REFRESH_SECRET;
    expect(() => jwtRefreshSecret()).toThrow(/JWT_REFRESH_SECRET is not set/);
  });

  it("treats an empty string as missing", () => {
    process.env.JWT_SECRET = "";
    expect(() => jwtSecret()).toThrow(/JWT_SECRET is not set/);
  });

  it("assertJwtSecrets fails boot when either secret is missing", () => {
    delete process.env.JWT_REFRESH_SECRET;
    expect(() => assertJwtSecrets()).toThrow(/JWT_REFRESH_SECRET is not set/);
  });
});

describe("customerJwtSecret", () => {
  const strong = "c".repeat(32);

  it("returns a secret of at least 32 chars that differs from JWT_SECRET", () => {
    process.env.CUSTOMER_JWT_SECRET = strong;
    expect(customerJwtSecret()).toBe(strong);
  });

  it("returns null (not a throw) when unset or empty, so staff routes keep running", () => {
    delete process.env.CUSTOMER_JWT_SECRET;
    expect(customerJwtSecret()).toBeNull();
    process.env.CUSTOMER_JWT_SECRET = "";
    expect(customerJwtSecret()).toBeNull();
  });

  it("returns null for a secret shorter than 32 chars", () => {
    process.env.CUSTOMER_JWT_SECRET = "c".repeat(31);
    expect(customerJwtSecret()).toBeNull();
  });

  it("returns null when it reuses the staff JWT_SECRET", () => {
    process.env.JWT_SECRET = strong;
    process.env.CUSTOMER_JWT_SECRET = strong;
    expect(customerJwtSecret()).toBeNull();
  });

  it("still works when JWT_SECRET itself is unset", () => {
    delete process.env.JWT_SECRET;
    process.env.CUSTOMER_JWT_SECRET = strong;
    expect(customerJwtSecret()).toBe(strong);
  });
});
