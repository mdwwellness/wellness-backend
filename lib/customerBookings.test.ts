import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFind, mockCreateBooking } = vi.hoisted(() => ({
  mockFind: vi.fn(),
  mockCreateBooking: vi.fn(),
}));
vi.mock("../models/appointmentsBookingModel.ts", () => ({ default: { find: mockFind } }));
vi.mock("./bookingService.ts", () => ({ createBooking: mockCreateBooking }));

import {
  createBookingForCustomer,
  listBookingsForPhone,
  toCustomerBooking,
  validateBookingRequest,
} from "./customerBookings.ts";

// A stored booking with every kind of internal field the app must never see.
const fullDoc = {
  _id: "665f00000000000000000001",
  enquiryId: "ENQ-0042",
  name: "Asha Verma",
  phonenumber: 9876543210,
  email: "asha@example.com",
  location: "12 Lake Road, Flat 3B",
  note: "Back pain since March",
  age: 34,
  service: "Home Therapy",
  typeOfappointment: "appointment",
  bookingKind: "course",
  status: "scheduled",
  slot: { date: new Date("2026-10-05T00:00:00.000Z"), time: "10:30" },
  doctor: "Dr. Reddy",
  doctorId: "THR-0007",
  sessionsCompleted: 1,
  totalSessions: 6,
  preferredReachOutTime: { from: "09:00", to: "12:00" },
  quotedPrice: 6000,
  paymentReceived: false,
  payToken: "a".repeat(32),
  customer_id: "CUST-0074",
  activityLog: [{ at: "2026-10-01", name: "Staff", action: "Created" }],
  visitOtpHash: "visit-hash",
  addonOtpHash: "addon-hash",
  reachedOutBy: { userId: "u1", name: "Exec" },
  assignedTo: { userId: "u1", name: "Exec" },
  therapistSplitPercent: 60,
  statusNote: "internal",
  sessionNotes: [{ session: 1, note: "private" }],
  source: "online",
  createdAt: new Date("2026-10-01T08:00:00.000Z"),
  updatedAt: new Date("2026-10-02T08:00:00.000Z"),
};

describe("toCustomerBooking", () => {
  it("returns exactly the allow-listed fields", () => {
    const b = toCustomerBooking(fullDoc);
    expect(Object.keys(b).sort()).toEqual(
      [
        "amountDue",
        "bookingKind",
        "createdAt",
        "enquiryId",
        "patientName",
        "payToken",
        "paymentReceived",
        "preferredReachOutTime",
        "service",
        "sessionsCompleted",
        "slot",
        "status",
        "therapistName",
        "totalSessions",
        "typeOfappointment",
      ].sort(),
    );
    expect(b).toEqual({
      enquiryId: "ENQ-0042",
      patientName: "Asha Verma",
      service: "Home Therapy",
      typeOfappointment: "appointment",
      bookingKind: "course",
      status: "scheduled",
      slot: { date: "2026-10-05", time: "10:30" },
      therapistName: "Dr. Reddy",
      sessionsCompleted: 1,
      totalSessions: 6,
      preferredReachOutTime: { from: "09:00", to: "12:00" },
      amountDue: 6000,
      paymentReceived: false,
      payToken: "a".repeat(32),
      createdAt: "2026-10-01T08:00:00.000Z",
    });
  });

  it("leaks no internal value anywhere in the output", () => {
    const json = JSON.stringify(toCustomerBooking(fullDoc));
    for (const secret of [
      "9876543210",
      "asha@example.com",
      "Lake Road",
      "Back pain",
      "visit-hash",
      "addon-hash",
      "Exec",
      "THR-0007",
      "CUST-0074",
      "internal",
      "private",
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it("maps missing fields to nulls / defaults instead of undefined", () => {
    // Nothing priced yet: nothing payable (null), and a fresh enquiry must not read as paid.
    expect(toCustomerBooking({ name: "Asha Verma", slot: {} })).toEqual({
      enquiryId: null,
      patientName: "Asha Verma",
      service: null,
      typeOfappointment: null,
      bookingKind: null,
      status: "enquiry",
      slot: null,
      therapistName: null,
      sessionsCompleted: 0,
      totalSessions: null,
      preferredReachOutTime: null,
      amountDue: null,
      paymentReceived: false,
      payToken: null,
      createdAt: null,
    });
  });

  it("shows the scheduled visit (physioSlot) first, falling back to the requested slot", () => {
    expect(toCustomerBooking({ physioSlot: { date: "2026-10-07", time: "16:00" } }).slot).toEqual({
      date: "2026-10-07",
      time: "16:00",
    });
    expect(
      toCustomerBooking({
        slot: { date: new Date("2026-10-05T00:00:00.000Z"), time: "10:30" },
        physioSlot: { date: "2026-10-07", time: "16:00" },
      }).slot,
    ).toEqual({ date: "2026-10-07", time: "16:00" });
    expect(toCustomerBooking({ slot: { date: new Date("2026-10-05T00:00:00.000Z"), time: "10:30" } }).slot).toEqual({
      date: "2026-10-05",
      time: "10:30",
    });
  });

  it("drops a half-filled preferred time window", () => {
    expect(
      toCustomerBooking({ preferredReachOutTime: { from: "09:00" } }).preferredReachOutTime,
    ).toBeNull();
  });

  it("amountDue: unpaid price is due, paid is 0, confirmed unpaid add-ons add up", () => {
    expect(toCustomerBooking({ quotedPrice: 1500, paymentReceived: false }).amountDue).toBe(1500);
    expect(toCustomerBooking({ quotedPrice: 1500, paymentReceived: true }).amountDue).toBe(0);
    const withAddons = toCustomerBooking({
      quotedPrice: 1500,
      paymentReceived: true,
      recommendedServices: [
        { serviceId: "SRV-1", serviceName: "Massage", quotedPrice: 800, status: "confirmed", recommendedAt: "t1" },
        // Pending add-ons are suggestions, not charges.
        { serviceId: "SRV-2", serviceName: "Taping", quotedPrice: 300, status: "pending", recommendedAt: "t2" },
      ],
    });
    expect(withAddons.amountDue).toBe(800);
  });

  it("course follow-up rows never owe their per-session share (billed on session 1)", () => {
    const followUp = toCustomerBooking({
      quotedPrice: 1000,
      paymentReceived: false,
      packageOriginId: "665f00000000000000000001",
    });
    // Nothing payable on this row; payment for the course lives on session 1.
    expect(followUp.amountDue).toBeNull();
    expect(followUp.paymentReceived).toBe(false);
  });

  it("course follow-up rows still owe a confirmed, unpaid add-on", () => {
    const followUp = toCustomerBooking({
      quotedPrice: 1000,
      paymentReceived: false,
      packageOriginId: "665f00000000000000000001",
      recommendedServices: [
        { serviceId: "SRV-1", serviceName: "Massage", quotedPrice: 800, status: "confirmed", recommendedAt: "t1" },
        { serviceId: "SRV-2", serviceName: "Taping", quotedPrice: 300, status: "confirmed", recommendedAt: "t2", paymentCollected: true },
      ],
    });
    expect(followUp.amountDue).toBe(800);
    expect(followUp.paymentReceived).toBe(false);
  });

  it("a cancelled booking owes nothing and has no pay link", () => {
    const cancelled = toCustomerBooking({ ...fullDoc, status: "cancelled" });
    expect(cancelled.amountDue).toBeNull();
    expect(cancelled.payToken).toBeNull();
    // With no amount to go on, the stored flag answers.
    expect(cancelled.paymentReceived).toBe(false);
    expect(toCustomerBooking({ ...fullDoc, status: "cancelled", paymentReceived: true }).paymentReceived).toBe(true);
  });

  it("paymentReceived follows the pay page: settled exactly when nothing is due", () => {
    // Paid the booking but owes a confirmed add-on: not settled.
    expect(
      toCustomerBooking({
        quotedPrice: 1500,
        paymentReceived: true,
        recommendedServices: [
          { serviceId: "SRV-1", serviceName: "Massage", quotedPrice: 800, status: "confirmed", recommendedAt: "t1" },
        ],
      }).paymentReceived,
    ).toBe(false);
    expect(toCustomerBooking({ quotedPrice: 1500, paymentReceived: true }).paymentReceived).toBe(true);
    expect(toCustomerBooking({ quotedPrice: 1500, paymentReceived: false }).paymentReceived).toBe(false);
  });
});

// AppointmentBooking.find(...).select(...).sort(...).limit(...).lean() resolving to `docs`.
function bookingsQueryReturns(docs: unknown[]) {
  const query: any = {};
  query.select = vi.fn(() => query);
  query.sort = vi.fn(() => query);
  query.limit = vi.fn(() => query);
  query.lean = vi.fn(() => Promise.resolve(docs));
  mockFind.mockReturnValue(query);
  return query;
}

describe("listBookingsForPhone", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queries by numeric phone, newest first, capped at 100", async () => {
    const query = bookingsQueryReturns([fullDoc]);
    const result = await listBookingsForPhone("9876543210");

    expect(mockFind).toHaveBeenCalledWith({ phonenumber: 9876543210 });
    expect(query.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(query.limit).toHaveBeenCalledWith(100);
    expect(result).toEqual([toCustomerBooking(fullDoc)]);
  });

  it("selects only what the view and the ledger need", async () => {
    const query = bookingsQueryReturns([]);
    await listBookingsForPhone("9876543210");

    const selected = String(query.select.mock.calls[0][0]).split(/\s+/);
    for (const needed of ["enquiryId", "status", "slot", "physioSlot", "quotedPrice", "recommendedServices", "packageOriginId", "createdAt"]) {
      expect(selected).toContain(needed);
    }
    for (const internal of ["location", "note", "email", "phonenumber", "activityLog", "visitOtpHash", "assignedTo"]) {
      expect(selected).not.toContain(internal);
    }
  });
});

describe("validateBookingRequest", () => {
  const ok = (body: unknown) => {
    const r = validateBookingRequest(body);
    if (!r.ok) throw new Error(`expected ok, got: ${r.message}`);
    return r.value;
  };
  const message = (body: unknown) => {
    const r = validateBookingRequest(body);
    if (r.ok) throw new Error("expected a validation error");
    return r.message;
  };

  it("accepts a full valid request and trims text", () => {
    expect(
      ok({
        service: "Vitals Check",
        preferredReachOutTime: { from: "09:00", to: "12:30" },
        note: "  call after 9  ",
        vitals: [" Blood Sugar ", "Blood Pressure (BP)"],
        location: " Salt Lake ",
      }),
    ).toEqual({
      service: "Vitals Check",
      preferredReachOutTime: { from: "09:00", to: "12:30" },
      note: "call after 9",
      vitals: ["Blood Sugar", "Blood Pressure (BP)"],
      location: "Salt Lake",
    });
  });

  it("accepts just a service, treating null / blank optionals as not given", () => {
    expect(ok({ service: "Home Therapy" })).toEqual({ service: "Home Therapy" });
    expect(
      ok({ service: "Home Therapy", note: "   ", location: "", vitals: [], preferredReachOutTime: null }),
    ).toEqual({ service: "Home Therapy" });
  });

  it("rejects a non-object body", () => {
    for (const body of [null, undefined, "x", 42, ["service"]]) {
      expect(message(body)).toBe("Invalid request body.");
    }
  });

  it("rejects staff-only and unknown fields by name", () => {
    for (const key of ["quotedPrice", "paymentReceived", "doctorId", "status", "discountAmount", "payToken", "source", "phonenumber", "name"]) {
      expect(message({ service: "Home Therapy", [key]: "x" })).toBe(`Unknown field(s): ${key}.`);
    }
    expect(message({ service: "Home Therapy", quotedPrice: 1, paymentReceived: true })).toBe(
      "Unknown field(s): quotedPrice, paymentReceived.",
    );
  });

  it("requires a known service", () => {
    for (const service of [undefined, "", "Massage", "home therapy", 1]) {
      expect(message({ service })).toMatch(/^Service must be one of/);
    }
  });

  it("checks the preferred time window", () => {
    for (const preferredReachOutTime of [
      "09:00-12:00",
      { from: "9:00", to: "12:00" },
      { from: "09:00", to: "24:00" },
      { from: "09:60", to: "12:00" },
      { from: "12:00", to: "09:00" },
      { from: "12:00", to: "12:00" },
      { from: "09:00" },
      { from: ["09:00"], to: ["12:00"] },
    ]) {
      expect(message({ service: "Home Therapy", preferredReachOutTime })).toMatch(/^Preferred time/);
    }
  });

  it("limits note and location length and type", () => {
    expect(message({ service: "Home Therapy", note: "x".repeat(1001) })).toMatch(/^Note/);
    expect(message({ service: "Home Therapy", note: 5 })).toMatch(/^Note/);
    expect(ok({ service: "Home Therapy", note: "x".repeat(1000) }).note).toHaveLength(1000);
    expect(message({ service: "Home Therapy", location: "x".repeat(301) })).toMatch(/^Location/);
    expect(message({ service: "Home Therapy", location: { city: "Kolkata" } })).toMatch(/^Location/);
  });

  it("allows vitals only for Vitals Check, up to 10 strings of 100 chars", () => {
    expect(message({ service: "Home Therapy", vitals: ["Blood Sugar"] })).toBe(
      "Vitals can only be sent with the Vitals Check service.",
    );
    for (const vitals of [
      "Blood Sugar",
      Array(11).fill("BP"),
      ["x".repeat(101)],
      [""],
      [42],
    ]) {
      expect(message({ service: "Vitals Check", vitals })).toMatch(/^Vitals must be/);
    }
    expect(ok({ service: "Vitals Check", vitals: Array(10).fill("BP") }).vitals).toHaveLength(10);
  });
});

describe("createBookingForCustomer", () => {
  beforeEach(() => vi.clearAllMocks());

  const who = { phone10: "9876543210", name: "Asha Verma", email: "asha@example.com", defaultLocation: "Profile address" };

  it("builds the createBooking input field by field and pins source + folding", async () => {
    mockCreateBooking.mockResolvedValue({ ok: true, folded: false, appointment: { enquiryId: "ENQ-0100" } });

    const result = await createBookingForCustomer(who, {
      service: "Vitals Check",
      preferredReachOutTime: { from: "09:00", to: "12:00" },
      note: "Morning please",
      vitals: ["Blood Sugar"],
      location: "Salt Lake",
    });

    expect(result).toEqual({ ok: true, enquiryId: "ENQ-0100", folded: false });
    expect(mockCreateBooking).toHaveBeenCalledTimes(1);
    const [input, opts] = mockCreateBooking.mock.calls[0];
    expect(input).toStrictEqual({
      name: "Asha Verma",
      phonenumber: 9876543210,
      email: "asha@example.com",
      location: "Salt Lake",
      typeOfappointment: "appointment",
      service: "Vitals Check",
      vitals: ["Blood Sugar"],
      preferredReachOutTime: { from: "09:00", to: "12:00" },
      note: "Morning please",
      status: "enquiry",
    });
    expect(opts).toStrictEqual({ source: "online", foldOpenRepeats: true });
  });

  it("maps Online Consultation to a consultation and falls back to the profile address", async () => {
    mockCreateBooking.mockResolvedValue({ ok: true, folded: false, appointment: { enquiryId: "ENQ-0101" } });

    await createBookingForCustomer(who, { service: "Online Consultation" });

    expect(mockCreateBooking.mock.calls[0][0]).toMatchObject({
      typeOfappointment: "consultation",
      service: "Online Consultation",
      location: "Profile address",
    });
  });

  it("maps Home Therapy to a home appointment and leaves out what wasn't given", async () => {
    mockCreateBooking.mockResolvedValue({ ok: true, folded: false, appointment: { enquiryId: "ENQ-0102" } });

    await createBookingForCustomer({ phone10: "9876543210", name: "Asha Verma" }, { service: "Home Therapy" });

    expect(mockCreateBooking.mock.calls[0][0]).toEqual({
      name: "Asha Verma",
      phonenumber: 9876543210,
      typeOfappointment: "appointment",
      service: "Home Therapy",
      status: "enquiry",
    });
  });

  it("reports a fold into an open enquiry", async () => {
    mockCreateBooking.mockResolvedValue({
      ok: true,
      folded: true,
      repeatCount: 2,
      appointment: { enquiryId: "ENQ-0042" },
    });

    expect(await createBookingForCustomer(who, { service: "Home Therapy" })).toEqual({
      ok: true,
      enquiryId: "ENQ-0042",
      folded: true,
    });
  });

  it("maps a createBooking refusal to { ok: false, status, message }", async () => {
    mockCreateBooking.mockResolvedValue({ ok: false, code: 400, message: "Name is required (at least 2 characters)." });

    expect(await createBookingForCustomer(who, { service: "Home Therapy" })).toEqual({
      ok: false,
      status: 400,
      message: "Name is required (at least 2 characters).",
    });
  });
});
