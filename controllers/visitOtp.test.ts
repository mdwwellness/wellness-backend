import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const { mockFindById, mockFindOneAndUpdate, mockDoctorFindOne } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockFindOneAndUpdate: vi.fn(),
  mockDoctorFindOne: vi.fn(),
}));
vi.mock("../models/appointmentsBookingModel.ts", () => ({
  default: { findById: mockFindById, findOneAndUpdate: mockFindOneAndUpdate, findByIdAndUpdate: mockFindOneAndUpdate },
}));
vi.mock("../models/doctorsModel.ts", () => ({ Doctor: { findOne: mockDoctorFindOne } }));
vi.mock("../models/customerModel.ts", () => ({ default: {} }));
vi.mock("../models/therapistLeaveModel.ts", () => ({ TherapistLeave: {} }));
vi.mock("../models/serviceModel.ts", () => ({ default: {} }));
vi.mock("../lib/logger.ts", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/counters.ts", () => ({ nextSequence: vi.fn() }));
vi.mock("../lib/invoiceGeneration.ts", () => ({ safeSyncInvoiceFromAppointment: vi.fn() }));
vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn(async (a: string) => a === "1234"), hash: vi.fn(async () => "hash") },
}));

import { completeSession, updateAppointment, verifyVisitOtp } from "./appointmentController.ts";

function res() {
  const r: any = {};
  r.status = vi.fn().mockReturnValue(r);
  r.send = vi.fn().mockReturnValue(r);
  return r as Response & { status: any };
}
const req = (code: string) =>
  ({ params: { id: "a1" }, body: { code }, user: { _id: "u1", role: "THERAPIST" } }) as unknown as Request;

let appt: any;
beforeEach(() => {
  vi.clearAllMocks();
  appt = {
    _id: "a1", doctorId: "THR-1", visitOtpHash: "hash",
    visitOtpExpiresAt: new Date(Date.now() + 60_000), save: vi.fn(),
  };
  mockFindById.mockReturnValue({ exec: () => Promise.resolve(appt) });
  mockDoctorFindOne.mockReturnValue({ lean: () => Promise.resolve({ doctorId: "THR-1" }) });
  mockFindOneAndUpdate.mockReturnValue({ exec: () => Promise.resolve(appt) });
});

describe("verifyVisitOtp", () => {
  it("the assigned therapist starts the session with the right code", async () => {
    const r = res();
    await verifyVisitOtp(req("1234"), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(appt.visitOtpVerified).toBe(true);
  });

  it("a code has no time limit - one sent days ago still works, and the time is recorded", async () => {
    appt.visitOtpExpiresAt = new Date(Date.now() - 3 * 86_400_000);
    appt.visitOtpSentAt = new Date(Date.now() - 3 * 86_400_000);
    const r = res();
    await verifyVisitOtp(req("1234"), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(appt.visitOtpVerifiedAt).toBeInstanceOf(Date);
  });

  it("won't start a visit until today's session is paid for", async () => {
    appt.quotedPrice = 1600;
    appt.paymentAmount = 600;
    const r = res();
    await verifyVisitOtp(req("1234"), r);
    expect(r.status).toHaveBeenCalledWith(402);
    expect((r.send as any).mock.calls[0][0]).toMatchObject({ short: 1000, due: 1000 });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled(); // no attempt used up
  });

  it("won't start when a same-day add-on is unpaid, even though the session is paid", async () => {
    appt.quotedPrice = 1600;
    appt.paymentAmount = 1600; // session's own share fully settled
    appt.recommendedServices = [
      { serviceId: "X", recommendedAt: "t", serviceName: "Accupunture", quotedPrice: 500, sessions: 1, status: "confirmed", firstInVisit: true, paidAmount: 0 },
    ];
    const r = res();
    await verifyVisitOtp(req("1234"), r);
    expect(r.status).toHaveBeenCalledWith(402);
    // short counts the add-on, due (the booking's own money) is 0, and the
    // add-on is reported separately so the UI can point at Billing.
    expect((r.send as any).mock.calls[0][0]).toMatchObject({ short: 500, due: 0, addonShort: 500, addons: ["Accupunture"] });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled(); // no attempt used up
  });

  it("refuses a therapist the visit isn't assigned to", async () => {
    mockDoctorFindOne.mockReturnValue({ lean: () => Promise.resolve({ doctorId: "THR-2" }) });
    const r = res();
    await verifyVisitOtp(req("1234"), r);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(appt.save).not.toHaveBeenCalled();
  });

  it("locks the code once its attempts are used up", async () => {
    mockFindOneAndUpdate.mockReturnValue({ exec: () => Promise.resolve(null) });
    const r = res();
    await verifyVisitOtp(req("1234"), r);
    expect(r.status).toHaveBeenCalledWith(429);
    expect(appt.visitOtpVerified).toBeUndefined();
  });

  it("rejects a wrong code", async () => {
    const r = res();
    await verifyVisitOtp(req("0000"), r);
    expect(r.status).toHaveBeenCalledWith(400);
  });
});

describe("updateAppointment - lead lock", () => {
  const put = (role: string, id: string) =>
    ({ params: { id: "a1" }, body: { status: "ongoing" }, user: { _id: id, role } }) as unknown as Request;

  beforeEach(() => {
    appt = { _id: "a1", doctorId: "THR-1", reachedOutBy: { userId: "exec1", name: "Manjeet Sharma" } };
  });

  it("lets the therapist save their visit on a lead an executive owns", async () => {
    const r = res();
    await updateAppointment(put("THERAPIST", "t1"), r);
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("still asks another executive for a reason", async () => {
    const r = res();
    await updateAppointment(put("STAFF", "exec2"), r);
    expect(r.status).toHaveBeenCalledWith(400);
  });
});

describe("completeSession: the work is recorded first", () => {
  const done = (body: object, role = "THERAPIST") =>
    ({ params: { id: "a1" }, body, user: { _id: "u1", role, userEmail: "t@x.com" } }) as unknown as Request;

  beforeEach(() => {
    appt.visitOtpVerified = true;
  });

  it("refuses a therapist who hasn't ticked Service performed or written a note", async () => {
    for (const body of [{}, { note: "Lower back, dry needling" }, { performed: true }, { performed: true, note: "  " }]) {
      const r = res();
      await completeSession(done(body), r);
      expect(r.status).toHaveBeenCalledWith(400);
      expect((r.send as any).mock.calls[0][0].message).toBe("Tick Service performed and write the session note first.");
    }
  });

  it("a tick already saved on the visit counts", async () => {
    appt.workChecklist = ["arrived", "performed"];
    const r = res();
    await completeSession(done({ note: "Lower back, dry needling" }), r);
    // Past the work check: whatever it hits next, it isn't this refusal.
    expect((r.send as any).mock.calls[0]?.[0]?.message).not.toBe("Tick Service performed and write the session note first.");
  });
});
