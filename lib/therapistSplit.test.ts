import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindOne } = vi.hoisted(() => ({ mockFindOne: vi.fn() }));
vi.mock("../models/doctorsModel.ts", () => ({
  Doctor: { findOne: mockFindOne },
}));

import { canManageSplit, lockedSplitFields, parseSplitPercent } from "./therapistSplit.ts";

function doctorWithSplit(splitPercent: number | null) {
  mockFindOne.mockReturnValue({ lean: () => Promise.resolve({ splitPercent }) });
}

describe("parseSplitPercent", () => {
  it("accepts 0-100, including numeric strings", () => {
    expect(parseSplitPercent(0)).toBe(0);
    expect(parseSplitPercent(100)).toBe(100);
    expect(parseSplitPercent("65")).toBe(65);
  });

  it("rejects out-of-range, non-numeric and empty values", () => {
    for (const v of [-1, 101, "abc", "", null, undefined, NaN]) {
      expect(parseSplitPercent(v)).toBeNull();
    }
  });
});

describe("canManageSplit", () => {
  it("is Admin / Super Admin only", () => {
    expect(canManageSplit("SUPER_ADMIN")).toBe(true);
    expect(canManageSplit("ADMIN")).toBe(true);
    for (const r of ["THERAPIST", "STAFF", "CUSTOMER_CARE", undefined]) {
      expect(canManageSplit(r)).toBe(false);
    }
  });
});

describe("lockedSplitFields", () => {
  beforeEach(() => vi.clearAllMocks());

  it("locks in the therapist's current split", async () => {
    doctorWithSplit(70);
    expect(await lockedSplitFields(undefined, "THR-0001")).toEqual({ therapistSplitPercent: 70 });
  });

  it("never overwrites a split that's already locked in", async () => {
    doctorWithSplit(70);
    expect(await lockedSplitFields(60, "THR-0001")).toEqual({});
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it("locks nothing without a therapist, or when the therapist has no split", async () => {
    expect(await lockedSplitFields(undefined, "")).toEqual({});
    doctorWithSplit(null);
    expect(await lockedSplitFields(undefined, "THR-0001")).toEqual({});
  });
});
