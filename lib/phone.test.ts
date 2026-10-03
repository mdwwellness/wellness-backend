import { describe, it, expect } from "vitest";
import { fromE164, maskPhone, parseIndianMobile, toE164 } from "./phone.ts";

describe("parseIndianMobile", () => {
  it("accepts a plain 10-digit mobile, as a string or a number", () => {
    expect(parseIndianMobile("9876543210")).toBe("9876543210");
    expect(parseIndianMobile(9876543210)).toBe("9876543210");
    expect(parseIndianMobile("6000000000")).toBe("6000000000");
  });

  it("strips a +91 / 91 country code and formatting", () => {
    expect(parseIndianMobile("+91 98765 43210")).toBe("9876543210");
    expect(parseIndianMobile("919876543210")).toBe("9876543210");
    expect(parseIndianMobile(919876543210)).toBe("9876543210");
    expect(parseIndianMobile("+91-98765-43210")).toBe("9876543210");
  });

  it("strips a leading trunk 0", () => {
    expect(parseIndianMobile("09876543210")).toBe("9876543210");
  });

  it("rejects numbers that are too short or too long", () => {
    expect(parseIndianMobile("987654321")).toBeNull();
    expect(parseIndianMobile("9198765432101")).toBeNull();
    expect(parseIndianMobile("0919876543210")).toBeNull();
    // 11 digits without the trunk 0, 12 digits without 91
    expect(parseIndianMobile("19876543210")).toBeNull();
    expect(parseIndianMobile("929876543210")).toBeNull();
  });

  it("rejects numbers that don't start with 6-9", () => {
    for (const first of ["0", "1", "2", "3", "4", "5"]) {
      expect(parseIndianMobile(`${first}876543210`)).toBeNull();
    }
    expect(parseIndianMobile("+91 5876543210")).toBeNull();
  });

  it("rejects junk and non-string, non-number input", () => {
    for (const junk of ["", "abc", "98765abc", null, undefined, {}, [], true, NaN]) {
      expect(parseIndianMobile(junk)).toBeNull();
    }
  });
});

describe("E.164 helpers", () => {
  it("round-trips a 10-digit mobile", () => {
    expect(toE164("9876543210")).toBe("+919876543210");
    expect(fromE164("+919876543210")).toBe("9876543210");
  });
});

describe("maskPhone", () => {
  it("shows only the last 4 digits", () => {
    expect(maskPhone("9876543210")).toBe("******3210");
    expect(maskPhone("+919876543210")).toBe("******3210");
    expect(maskPhone("")).toBe("******");
  });
});
