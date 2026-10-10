import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindOne } = vi.hoisted(() => ({ mockFindOne: vi.fn() }));
vi.mock("../models/doctorsModel.ts", () => ({ Doctor: { findOne: mockFindOne } }));

import {
  REFERRAL_ALPHABET,
  generateReferralCode,
  normalizeReferralCode,
  referrerForCode,
  withUniqueReferralCode,
} from "./referralCode.ts";

const clash = () => Object.assign(new Error("dup"), { code: 11000, keyPattern: { referralCode: 1 } });

beforeEach(() => vi.clearAllMocks());

describe("referral codes", () => {
  it("uses 31 characters, none of them easy to misread", () => {
    expect(REFERRAL_ALPHABET).toHaveLength(31);
    for (const c of "O0I1L") expect(REFERRAL_ALPHABET).not.toContain(c);
  });

  it("generates 5 characters from the alphabet", () => {
    for (let i = 0; i < 200; i++) expect(generateReferralCode()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{5}$/);
  });

  it("normalizes typed input and rejects what can't be a code", () => {
    expect(normalizeReferralCode(" k7m3q ")).toBe("K7M3Q");
    for (const bad of ["K7M3", "K7M3QX", "K0M3Q", "K7-3Q", "", 12345, null, undefined]) {
      expect(normalizeReferralCode(bad)).toBeNull();
    }
  });
});

describe("referrerForCode", () => {
  it("returns the active owner's doctorId", async () => {
    mockFindOne.mockReturnValue({ lean: () => Promise.resolve({ doctorId: "THR-0012" }) });
    expect(await referrerForCode("k7m3q")).toBe("THR-0012");
    expect(mockFindOne.mock.calls[0][0]).toEqual({ referralCode: "K7M3Q", isActive: { $ne: false } });
  });

  it("ignores unknown codes and never queries for malformed ones", async () => {
    mockFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    expect(await referrerForCode("K7M3Q")).toBeNull();
    expect(await referrerForCode("THR-0012")).toBeNull();
    expect(mockFindOne).toHaveBeenCalledTimes(1);
  });
});

describe("withUniqueReferralCode", () => {
  it("retries with a fresh code when the unique index clashes", async () => {
    const save = vi.fn().mockRejectedValueOnce(clash()).mockResolvedValueOnce("saved");
    expect(await withUniqueReferralCode(save)).toBe("saved");
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0][0]).not.toBe(undefined);
  });

  it("rethrows other errors at once, and gives up after 5 clashes", async () => {
    await expect(withUniqueReferralCode(vi.fn().mockRejectedValue(new Error("boom")))).rejects.toThrow("boom");
    const always = vi.fn().mockRejectedValue(clash());
    await expect(withUniqueReferralCode(always)).rejects.toThrow("dup");
    expect(always).toHaveBeenCalledTimes(5);
  });
});
