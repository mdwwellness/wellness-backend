import { describe, it, expect, vi, beforeEach } from "vitest";

// That therapist's visits per day, and the clinic's booking gap.
const m = vi.hoisted(() => ({ byDate: {} as Record<string, any[]>, gap: 60 }));

vi.mock("../models/appointmentsBookingModel.ts", () => ({
  default: { find: (filter: any) => ({ lean: async () => m.byDate[String(filter["slot.date"])] ?? [] }) },
}));
vi.mock("../models/clinicSettingsModel.ts", () => ({
  default: { findOne: () => ({ lean: async () => ({ bookingGapMinutes: m.gap }) }) },
}));
vi.mock("./logger.ts", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./bookingSource.ts", () => ({ resolveBookingSource: async () => ({ ok: true, fields: {} }) }));
vi.mock("./invoiceGeneration.ts", () => ({ ensureCustomerForAppointment: vi.fn(), maybeCreateInvoiceForAppointment: vi.fn() }));

import { createBooking, findTherapistClash } from "./bookingService.ts";

const DAY = "2027-01-15";
const at = (start: string, end?: string) => findTherapistClash({ doctorId: "THR-1", date: DAY, start, end });

beforeEach(() => {
  m.gap = 60;
  m.byDate = { [DAY]: [{ slot: { date: DAY, time: "14:30" }, therapyStartTime: "14:30", therapyEndTime: "15:30" }] };
});

describe("findTherapistClash", () => {
  it("refuses a visit that ends right as another starts (no gap)", async () => {
    expect(await at("13:30", "14:30")).toBe("needs 60 min between visits and has one at 14:30");
  });

  it("allows a visit that leaves the full gap", async () => {
    expect(await at("12:30", "13:30")).toBeNull();
    expect(await at("16:30", "17:30")).toBeNull();
  });

  it("refuses an overlap", async () => {
    expect(await at("14:00", "15:00")).toBe("is already booked at 14:30");
  });

  it("compares times as times, not text ('9:30' before '10:30')", async () => {
    m.byDate[DAY] = [{ slot: { date: DAY, time: "10:30" } }];
    expect(await at("9:30", "11:00")).toBe("is already booked at 10:30");
  });

  it("a visit with no end time counts as 60 minutes", async () => {
    m.byDate[DAY] = [{ slot: { date: DAY, time: "14:30" } }];
    expect(await at("15:30")).toBe("needs 60 min between visits and has one at 14:30");
  });

  it("with no gap set, back-to-back is fine", async () => {
    m.gap = 0;
    expect(await at("13:30", "14:30")).toBeNull();
  });
});

describe("createBooking: a course checks every session before saving", () => {
  it("refuses the course when a later session clashes, naming it", async () => {
    m.byDate = { "2027-01-22": [{ slot: { date: "2027-01-22", time: "10:30" } }] };
    const result = await createBooking({
      name: "Asha",
      phonenumber: 9876500001,
      doctorId: "THR-1",
      slot: { date: "2027-01-15", time: "10:30" },
      therapyStartTime: "10:30",
      therapyEndTime: "11:30",
      bookingKind: "course",
      totalSessions: 3,
      sessionIntervalDays: 7,
    });
    expect(result).toEqual({
      ok: false,
      code: 409,
      message: "That therapist is already booked at 10:30 on 2027-01-22 (session 2).",
    });
  });
});
