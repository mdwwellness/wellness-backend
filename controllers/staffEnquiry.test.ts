import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const m = vi.hoisted(() => ({ createBooking: vi.fn(), referrerForCode: vi.fn() }));
vi.mock("../models/appointmentsBookingModel.ts", () => ({ default: {} }));
vi.mock("../models/doctorsModel.ts", () => ({ Doctor: {} }));
vi.mock("../models/customerModel.ts", () => ({ default: {} }));
vi.mock("../models/therapistLeaveModel.ts", () => ({ TherapistLeave: {} }));
vi.mock("../models/serviceModel.ts", () => ({ default: {} }));
vi.mock("../lib/logger.ts", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/counters.ts", () => ({ nextSequence: vi.fn() }));
vi.mock("../lib/invoiceGeneration.ts", () => ({ safeSyncInvoiceFromAppointment: vi.fn() }));
vi.mock("../lib/bookingService.ts", () => ({ createBooking: m.createBooking }));
vi.mock("../lib/referralCode.ts", () => ({ referrerForCode: m.referrerForCode }));

import { addAppointmentsDetails } from "./appointmentController.ts";

function res() {
  const r: any = {};
  r.status = vi.fn().mockReturnValue(r);
  r.send = vi.fn().mockReturnValue(r);
  return r as Response & { status: any; send: any };
}
const create = (body: object) =>
  ({ body, user: { role: "STAFF", userfName: "Riya", userlName: "Sen" } }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  m.createBooking.mockResolvedValue({ ok: true, appointment: { enquiryId: "ENQ-0200" } });
});

describe("New enquiry from the dashboard: referral code", () => {
  it("a valid code makes it the referring therapist's booking", async () => {
    m.referrerForCode.mockResolvedValue("THR-0007");
    await addAppointmentsDetails(create({ name: "Asha", phonenumber: 9876543210, source: "whatsapp", referralCode: "ck43z" }), res());
    const input = m.createBooking.mock.calls[0][0];
    expect(input).toMatchObject({ source: "therapist", referredByDoctorId: "THR-0007" });
    expect(input).not.toHaveProperty("referralCode");
  });

  it("a wrong code is refused with a clear message, and nothing is created", async () => {
    m.referrerForCode.mockResolvedValue(null);
    const r = res();
    await addAppointmentsDetails(create({ name: "Asha", phonenumber: 9876543210, referralCode: "NOPE1" }), r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(r.send).toHaveBeenCalledWith(expect.objectContaining({ message: "That referral code doesn't match an active therapist." }));
    expect(m.createBooking).not.toHaveBeenCalled();
  });

  it("without a code, the picked source goes through untouched", async () => {
    await addAppointmentsDetails(create({ name: "Asha", phonenumber: 9876543210, source: "walk_in", referralCode: " " }), res());
    expect(m.referrerForCode).not.toHaveBeenCalled();
    expect(m.createBooking.mock.calls[0][0]).toMatchObject({ source: "walk_in" });
  });
});
