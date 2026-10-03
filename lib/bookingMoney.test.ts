import { describe, it, expect } from "vitest";
import { bookingLedger, payableLedger } from "./bookingMoney.ts";

const addOn = (over: object = {}) => ({
  serviceId: "SRV-1",
  serviceName: "Massage",
  quotedPrice: 800,
  status: "confirmed",
  recommendedAt: "t1",
  ...over,
});

describe("payableLedger", () => {
  it("matches bookingLedger for an ordinary booking", () => {
    const booking = { quotedPrice: 1500, paymentReceived: false, recommendedServices: [addOn()] };
    expect(payableLedger(booking)).toEqual(bookingLedger(booking));
  });

  it("drops a course follow-up's per-session share but keeps its unpaid add-ons", () => {
    const followUp = {
      packageOriginId: "665f00000000000000000001",
      quotedPrice: 1000,
      paymentReceived: false,
      recommendedServices: [addOn(), addOn({ serviceId: "SRV-2", quotedPrice: 300, paymentCollected: true })],
    };
    const { lines, due, paid } = payableLedger(followUp);
    expect(lines.map((l) => l.label)).toEqual(["Massage", "Massage"]);
    expect(due).toBe(800);
    expect(paid).toBe(300);
  });

  it("accepts Mongoose-style nulls", () => {
    expect(payableLedger({ quotedPrice: null, paymentReceived: null, recommendedServices: null })).toEqual({
      lines: [],
      due: 0,
      paid: 0,
    });
  });
});
