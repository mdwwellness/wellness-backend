import { describe, expect, it } from "vitest";
import { allocatePaid, listPrice, sessionShare } from "./invoiceView.ts";

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

describe("listPrice", () => {
  // Rate card: 1-5 sessions ₹1600, 6-10 ₹1500.
  it("a 6-session package at ₹1500 each shows the standard ₹1600 each crossed out", () => {
    expect(listPrice(9000, 6, 1600)).toBe(9600);
  });

  it("nothing to cross out when it's charged at the standard rate", () => {
    expect(listPrice(1600 * 3, 3, 1600)).toBeUndefined();
    expect(listPrice(9000, 6, 0)).toBeUndefined(); // no rate card
  });

  it("an offer on top: the higher of the two 'before' prices", () => {
    expect(listPrice(8000, 6, 1600, 9000)).toBe(9600);
    expect(listPrice(8000, 6, 1300, 9000)).toBe(9000);
  });
});
