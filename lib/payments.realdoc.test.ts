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

describe("a course with a visit per session (ENQ-0112)", () => {
  const origin = () =>
    new AppointmentBooking({
      name: "Course", phonenumber: 9000000000, bookingKind: "course",
      totalSessions: 3, sessionIntervalDays: 7, quotedPrice: 4800, paymentAmount: 1600,
      // what the old completion left behind: a counter that moved on
      sessionsCompleted: 1, sessionNumber: 2,
    });

  it("the booking itself is always session 1 - its counter can't move it on", async () => {
    const { courseSessionOf } = await import("./payments.ts");
    expect(courseSessionOf(origin())).toEqual({ session: 1, total: 3 });
    expect(shortBeforeStart(origin(), origin())).toBe(0); // session 1 is paid (1600 of 4800)
  });

  it("a follow-up is its own session number", async () => {
    const { courseSessionOf } = await import("./payments.ts");
    const o = origin();
    const s3 = new AppointmentBooking({ name: "Course", phonenumber: 9000000000, bookingKind: "course", totalSessions: 3, sessionNumber: 3, packageOriginId: String(o._id) });
    expect(courseSessionOf(s3)).toEqual({ session: 3, total: 3 });
    expect(shortBeforeStart(s3, o)).toBe(3200); // sessions 2 and 3 still to pay
  });

  it("a one-booking catalogue package isn't split", async () => {
    const { courseSessionOf } = await import("./payments.ts");
    expect(courseSessionOf(new AppointmentBooking({ name: "P", phonenumber: 9000000000, bookingKind: "course", totalSessions: 6 }))).toBeNull();
  });
});
