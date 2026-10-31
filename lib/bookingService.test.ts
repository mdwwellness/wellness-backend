import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  find: vi.fn(),
  created: [] as any[],
  nextSequence: vi.fn(),
  ensureCustomer: vi.fn(),
  maybeInvoice: vi.fn(),
  syncMeet: vi.fn(),
}));

vi.mock("../models/appointmentsBookingModel.ts", () => ({
  default: class FakeBooking {
    static find = m.find;
    activityLog: unknown[] = [];
    constructor(fields: object) {
      Object.assign(this, fields);
      m.created.push(this);
    }
    save = vi.fn();
  },
}));
vi.mock("./counters.ts", () => ({ nextSequence: m.nextSequence }));
vi.mock("./bookingMeet.ts", () => ({ syncBookingMeet: m.syncMeet }));
vi.mock("./logger.ts", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./bookingSource.ts", () => ({
  resolveBookingSource: async () => ({ ok: true, fields: { source: "online" } }),
}));
vi.mock("./invoiceGeneration.ts", () => ({
  ensureCustomerForAppointment: m.ensureCustomer,
  maybeCreateInvoiceForAppointment: m.maybeInvoice,
}));

import { courseDayOffset, courseScheduleOf, createBooking } from "./bookingService.ts";

const PHONE = 9876543210;

function lead(fields: Record<string, unknown> = {}) {
  return {
    enquiryId: "ENQ-0042",
    name: "Asha Verma",
    service: "Vitals Check",
    status: "enquiry",
    repeatCount: 1,
    activityLog: [] as { action: string }[],
    customerNotes: [] as unknown[], // real records always have the list
    save: vi.fn(),
    ...fields,
  };
}

const request = (fields: Record<string, unknown> = {}) => ({
  name: "Asha Verma",
  phonenumber: PHONE,
  service: "Vitals Check",
  status: "enquiry",
  ...fields,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.created.length = 0;
  m.nextSequence.mockResolvedValue(100);
  m.syncMeet.mockResolvedValue(null);
});

describe("createBooking: repeat folding", () => {
  it("folds a repeat of the same request into the open enquiry, logging what was re-sent", async () => {
    const existing = lead();
    m.find.mockResolvedValue([existing]);

    const result = await createBooking(
      request({ name: "  asha VERMA ", vitals: ["Blood Sugar", "BP"], note: "mornings" }),
      { foldOpenRepeats: true },
    );

    expect(result).toMatchObject({ ok: true, folded: true, repeatCount: 2, appointment: existing });
    // Scheduled / ongoing bookings and course follow-ups are never candidates.
    expect(m.find).toHaveBeenCalledWith({ phonenumber: PHONE, status: "enquiry" });
    expect(existing.activityLog[0].action).toBe(
      "Re-submitted (#2): service: Vitals Check, vitals: Blood Sugar, BP, note: mornings",
    );
    expect(existing.save).toHaveBeenCalled();
    expect(m.created).toHaveLength(0);
  });

  it("a repeat's message becomes a customer note on the lead; the first message stays", async () => {
    const existing: any = lead({ note: "Back pain" });
    m.find.mockResolvedValue([existing]);

    await createBooking(request({ note: "  Now also neck stiffness " }), { foldOpenRepeats: true });
    await createBooking(request({}), { foldOpenRepeats: true }); // no message: nothing added

    expect(existing.note).toBe("Back pain");
    expect(existing.customerNotes).toEqual([
      { at: expect.any(String), note: "Now also neck stiffness", repeat: 2 },
    ]);
  });

  it("a repeat fills the lead's missing gender and age, and passes them to the customer", async () => {
    const existing = lead({ age: 41 });
    m.find.mockResolvedValue([existing]);

    await createBooking(request({ gender: "female", age: 30 }), { foldOpenRepeats: true });

    expect(existing).toMatchObject({ gender: "female", age: 41 });
    expect(m.ensureCustomer).toHaveBeenCalledWith(existing);
  });

  it("creates a new lead for a different service on the same phone and name", async () => {
    m.find.mockResolvedValue([lead({ service: "Home Therapy" })]);

    const result = await createBooking(request(), { foldOpenRepeats: true });

    expect(result).toMatchObject({ ok: true, folded: false });
    expect(m.created).toHaveLength(1);
    expect(m.created[0]).toMatchObject({ enquiryId: "ENQ-0100", service: "Vitals Check" });
  });

  it("treats a missing service on both sides as the same request, but not on one side", async () => {
    m.find.mockResolvedValue([lead({ service: undefined })]);
    expect(await createBooking(request({ service: undefined }), { foldOpenRepeats: true })).toMatchObject({
      folded: true,
    });

    m.find.mockResolvedValue([lead({ service: undefined })]);
    expect(await createBooking(request(), { foldOpenRepeats: true })).toMatchObject({ folded: false });
  });

  it("creates a new lead for a different person on the same phone", async () => {
    m.find.mockResolvedValue([lead({ name: "Ravi Verma" })]);
    expect(await createBooking(request(), { foldOpenRepeats: true })).toMatchObject({ folded: false });
  });

  it("never folds unless the caller opts in", async () => {
    expect(await createBooking(request())).toMatchObject({ ok: true, folded: false });
    expect(m.find).not.toHaveBeenCalled();
  });
});

describe("createBooking: customer link", () => {
  it("ignores a client-sent customer_id, so the server links it and fills known details", async () => {
    await createBooking(request({ customer_id: "CUST-0098" }));

    expect(m.created[0].customer_id).toBeUndefined();
    expect(m.ensureCustomer).toHaveBeenCalledWith(m.created[0]);
  });
});

describe("createBooking: video call", () => {
  it("returns the new booking with its Meet link, so the form can show it", async () => {
    m.find.mockResolvedValue([]);
    const meet = { link: "https://meet.google.com/abc-defg-hij", eventId: "ev1", start: "s", end: "e" };
    m.syncMeet.mockResolvedValue(meet);
    const result: any = await createBooking(request({ status: "scheduled" }));
    expect(m.syncMeet).toHaveBeenCalledWith(m.created[0]);
    expect(result.appointment.meet).toEqual(meet);
  });

  it("leaves it off when no call was made", async () => {
    m.find.mockResolvedValue([]);
    const result: any = await createBooking(request());
    expect(result.appointment.meet).toBeUndefined();
  });
});

describe("course schedule: so many sessions a week", () => {
  // Offsets in days from session 1, for the first 8 sessions.
  const offsets = (perWeek: number) =>
    Array.from({ length: 8 }, (_, i) => courseDayOffset(i + 1, { perWeek, intervalDays: 0 }));

  it("spreads the sessions evenly through each week", () => {
    expect(offsets(1)).toEqual([0, 7, 14, 21, 28, 35, 42, 49]);
    expect(offsets(2)).toEqual([0, 3, 7, 10, 14, 17, 21, 24]); // Tue, Fri, Tue, Fri...
    expect(offsets(3)).toEqual([0, 2, 4, 7, 9, 11, 14, 16]); // Mon, Wed, Fri...
    expect(offsets(4)).toEqual([0, 1, 3, 5, 7, 8, 10, 12]);
  });

  it("older courses keep their every-N-days interval", () => {
    expect(courseDayOffset(3, { perWeek: 0, intervalDays: 14 })).toBe(28);
  });

  it("only 1 to 4 a week counts as a schedule", () => {
    expect(courseScheduleOf({ sessionsPerWeek: 2 })).toEqual({ perWeek: 2, intervalDays: 0 });
    expect(courseScheduleOf({ sessionsPerWeek: 5 })).toBeNull();
    expect(courseScheduleOf({ sessionIntervalDays: 7 })).toEqual({ perWeek: 0, intervalDays: 7 });
    expect(courseScheduleOf({})).toBeNull();
  });
});
