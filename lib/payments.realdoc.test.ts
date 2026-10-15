import { describe, it, expect } from "vitest";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { dueForVisit, shortBeforeStart, unpaidBeforeComplete } from "./payments.ts";

// Real Mongoose documents (no database needed), not plain objects: a stored
// booking has an empty `addonOf` object even when it isn't an add-on visit,
// which once made these checks treat ENQ-0110 as "nothing to collect".
describe("payment checks on real booking documents", () => {
  const booking = () =>
    new AppointmentBooking({
      name: "Part paid",
      phonenumber: 9439839392,
      typeOfappointment: "consultation",
      quotedPrice: 600,
      paymentAmount: 400,
    });

  it("ENQ-0110: a part-paid single visit can't start or complete", () => {
    const doc = booking();
    expect(shortBeforeStart(doc, doc)).toBe(200);
    expect(unpaidBeforeComplete(doc, doc).amount).toBe(200);
    expect(dueForVisit(doc, doc)).toBe(200);
  });

  it("is clear once fully paid", () => {
    const doc = booking();
    doc.paymentAmount = 600;
    expect(shortBeforeStart(doc, doc)).toBe(0);
    expect(unpaidBeforeComplete(doc, doc).amount).toBe(0);
  });
});

describe("payable ledger - one line per item", () => {
  it("a part-paid booking is one line with what's still owed", async () => {
    const { payableLedger } = await import("./bookingMoney.ts");
    const { lines, due, paid } = payableLedger({ quotedPrice: 600, paymentAmount: 400, typeOfappointment: "consultation" });
    expect(lines).toEqual([{ key: "booking", label: "Online consultation", amount: 600, due: 200, state: "due" }]);
    expect({ due, paid }).toEqual({ due: 200, paid: 400 });
  });
});
