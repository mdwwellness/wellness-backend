import { describe, expect, it } from "vitest";
import { allocatePaid, sessionShare } from "./invoiceView.ts";

describe("allocatePaid", () => {
  it("covers the earliest sessions first, with the methods that paid them", () => {
    const rows = allocatePaid([1500, 1500, 1500, 1500], 3750, [
      { amount: 3000, method: "upi" },
      { amount: 750, method: "cash" },
    ]);
    expect(rows).toEqual([
      { pay: "paid", method: "UPI" },
      { pay: "paid", method: "UPI" },
      { pay: "part", method: "Cash" },
      { pay: "due", method: undefined },
    ]);
  });

  it("names both methods when a session was paid by two", () => {
    const rows = allocatePaid([1000, 1000], 2000, [
      { amount: 1500, method: "upi" },
      { amount: 500, method: "cash" },
    ]);
    expect(rows[1]).toEqual({ pay: "paid", method: "UPI + Cash" });
  });

  it("trusts the line's paid amount when older payments weren't itemised", () => {
    expect(allocatePaid([500], 500, [])).toEqual([{ pay: "paid", method: undefined }]);
  });

  it("never shows more paid than the line's paid amount", () => {
    expect(allocatePaid([500, 500], 500, [{ amount: 900, method: "card" }])[1].pay).toBe("due");
  });
});

describe("sessionShare", () => {
  it("splits a price that doesn't divide evenly so the shares add up to it", () => {
    const shares = [1, 2, 3].map((n) => sessionShare(1000, 3, n));
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(shares).toEqual([333, 334, 333]);
  });
});
