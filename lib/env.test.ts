import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertJwtSecrets, jwtRefreshSecret, jwtSecret } from "./env.ts";

const original = {
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
};

beforeEach(() => {
  process.env.JWT_SECRET = "test-access-secret";
  process.env.JWT_REFRESH_SECRET = "test-refresh-secret";
});

afterEach(() => {
  process.env.JWT_SECRET = original.JWT_SECRET;
  process.env.JWT_REFRESH_SECRET = original.JWT_REFRESH_SECRET;
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
