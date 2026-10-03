import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  find: vi.fn(),
  created: [] as any[],
  nextSequence: vi.fn(),
  ensureCustomer: vi.fn(),
  maybeInvoice: vi.fn(),
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
vi.mock("./logger.ts", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./bookingSource.ts", () => ({
  resolveBookingSource: async () => ({ ok: true, fields: { source: "online" } }),
}));
vi.mock("./invoiceGeneration.ts", () => ({
  ensureCustomerForAppointment: m.ensureCustomer,
  maybeCreateInvoiceForAppointment: m.maybeInvoice,
}));

import { createBooking } from "./bookingService.ts";

const PHONE = 9876543210;

function lead(fields: Record<string, unknown> = {}) {
  return {
    enquiryId: "ENQ-0042",
    name: "Asha Verma",
    service: "Vitals Check",
    status: "enquiry",
    repeatCount: 1,
    activityLog: [] as { action: string }[],
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
