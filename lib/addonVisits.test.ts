import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockClash } = vi.hoisted(() => ({ mockClash: vi.fn() }));
vi.mock("./bookingService.ts", () => ({ findTherapistClash: mockClash, bookingTimeProblem: () => null }));
vi.mock("../models/appointmentsBookingModel.ts", () => ({ default: {} }));
vi.mock("../models/doctorsModel.ts", () => ({ Doctor: {} }));
vi.mock("./counters.ts", () => ({ nextSequence: vi.fn() }));

import { addonSessions, checkAddonSchedule, endTime } from "./addonVisits.ts";
import { shortBeforeStart, unpaidBeforeComplete } from "./payments.ts";

const future = (days: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
};

describe("add-on scheduling", () => {
  beforeEach(() => mockClash.mockResolvedValue(null));

  it("a session on the visit's own day is done in that visit; the rest become visits", () => {
    const booking = { physioSlot: { date: "2026-11-02" } };
    const sessions = addonSessions({ slot: { date: "2026-11-02" }, sessions: 3, intervalDays: 7 }, booking);
    expect(sessions).toEqual([
      { session: 1, date: "2026-11-02", inVisit: true },
      { session: 2, date: "2026-11-09", inVisit: false },
      { session: 3, date: "2026-11-16", inVisit: false },
    ]);
  });

  it("on a completed visit every session becomes its own visit, even the same day", () => {
    const booking = { status: "completed", physioSlot: { date: "2026-11-02" } };
    expect(addonSessions({ slot: { date: "2026-11-02" }, sessions: 1 }, booking)[0].inVisit).toBe(false);
  });

  it("needs a therapist, a date and time, and an interval for several sessions", async () => {
    expect(await checkAddonSchedule({}, { slot: { date: future(1), time: "10:00" } })).toMatchObject({ ok: false });
    const booking = { doctorId: "THR-1", physioSlot: { date: future(0) } };
    expect(await checkAddonSchedule(booking, { slot: { date: "", time: "" } })).toMatchObject({ ok: false });
    expect(await checkAddonSchedule(booking, { slot: { date: future(1), time: "10:00" }, sessions: 3 })).toMatchObject({ ok: false });
    const ok = await checkAddonSchedule(booking, { slot: { date: future(1), time: "10:00" }, sessions: 3, intervalDays: 7, durationMin: 90 });
    expect(ok).toMatchObject({ ok: true, fields: { durationMin: 90, intervalDays: 7, firstInVisit: false } });
  });

  it("refuses a time that clashes with the therapist's other visits", async () => {
    mockClash.mockResolvedValue({ _id: "other" });
    const r = await checkAddonSchedule({ doctorId: "THR-1", doctor: "Dr A" }, { slot: { date: future(2), time: "10:00" } });
    expect(r).toMatchObject({ ok: false, code: 409 });
  });

  it("works out the end time", () => {
    expect(endTime("11:30", 90)).toBe("13:00");
  });
});

describe("add-on money", () => {
  const booking = {
    quotedPrice: 1600,
    paymentAmount: 1600,
    recommendedServices: [
      { serviceId: "S", recommendedAt: "t", serviceName: "Dry Needling", quotedPrice: 2400, sessions: 6, status: "confirmed", firstInVisit: true, paidAmount: 0 },
    ],
  };

  it("today's add-on session must be paid before today's visit completes", () => {
    expect(unpaidBeforeComplete(booking, booking)).toEqual({ amount: 400, addons: ["Dry Needling"] });
  });

  it("a confirmed same-day add-on is required before the session can START too", () => {
    // The booking's own share is fully paid (1600/1600); only the add-on is owed,
    // yet the session must not start until it is collected.
    expect(shortBeforeStart(booking, booking)).toBe(400);
  });

  it("an add-on deferred to a later visit does not block today's start", () => {
    const deferred = { ...booking, recommendedServices: [{ ...booking.recommendedServices[0], firstInVisit: false }] };
    expect(shortBeforeStart(deferred, deferred)).toBe(0);
  });

  it("an add-on visit needs its sessions-so-far share before it starts", () => {
    const visit3 = { addonOf: { bookingId: "b", key: "S|t", session: 3 } };
    expect(shortBeforeStart(visit3, { ...booking, recommendedServices: [{ ...booking.recommendedServices[0], paidAmount: 800 }] })).toBe(400);
  });
});
