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

  it("starts the session even when today's visit is unpaid - payment is checked at completion now", async () => {
    appt.quotedPrice = 1600;
    appt.paymentAmount = 600;
    const r = res();
    await verifyVisitOtp(req("1234"), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(appt.visitOtpVerified).toBe(true);
  });

  it("starts even when a same-day add-on is unpaid - the OTP, not money, gates the start", async () => {
    appt.quotedPrice = 1600;
    appt.paymentAmount = 1600; // session's own share fully settled
    appt.recommendedServices = [
      { serviceId: "X", recommendedAt: "t", serviceName: "Accupunture", quotedPrice: 500, sessions: 1, status: "confirmed", firstInVisit: true, paidAmount: 0 },
    ];
    const r = res();
    await verifyVisitOtp(req("1234"), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(appt.visitOtpVerified).toBe(true);
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

describe("updateAppointment - money fields can't be smuggled in (ISSUES #48)", () => {
  const put = (role: string, body: object) =>
    ({ params: { id: "a1" }, body, user: { _id: "t1", role } }) as unknown as Request;
  const written = () => mockFindOneAndUpdate.mock.calls.at(-1)?.[1];

  beforeEach(() => {
    appt = {
      _id: "a1", doctorId: "THR-1", therapistPaid: true,
      activityLog: [{ at: "2026-10-01T10:00:00.000Z", userId: "a", name: "Admin", action: "Therapist reassigned" }],
    };
  });

  it("refuses a Mongo operator or a dotted path", async () => {
    for (const body of [
      { status: "ongoing", $set: { therapistSplitPercent: 100 } },
      { $inc: { paymentAmount: 5000 } },
      { "recommendedServices.0.paidAmount": 5000 },
    ]) {
      const r = res();
      await updateAppointment(put("THERAPIST", body), r);
      expect(r.status).toHaveBeenCalledWith(400);
    }
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("a therapist can't un-mark their payout or rewrite add-ons, offers or session counts", async () => {
    const r = res();
    await updateAppointment(put("THERAPIST", {
      status: "ongoing", therapistPaid: false, therapistPaidAt: null,
      recommendedServices: [{ paidAmount: 9999 }], appliedOffers: [], sessionsCompleted: 5, discountCode: "X",
    }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    for (const f of ["therapistPaid", "therapistPaidAt", "recommendedServices", "appliedOffers", "sessionsCompleted", "discountCode"]) {
      expect(written()).not.toHaveProperty(f);
    }
  });

  it("not even an admin marks a payout through the PUT (it has its own endpoint)", async () => {
    const r = res();
    await updateAppointment(put("ADMIN", { therapistPaid: false, therapistPayouts: [] }), r);
    expect(written()).not.toHaveProperty("therapistPaid");
    expect(written()).not.toHaveProperty("therapistPayouts");
  });

  it("a visit can't be pointed at another booking's money, and a therapist can't mark it completed by hand", async () => {
    const r = res();
    await updateAppointment(put("THERAPIST", {
      packageOriginId: "other", sessionNumber: 3, addonOf: { bookingId: "other" }, bookingKind: "course", totalSessions: 9, status: "completed",
    }), r);
    for (const f of ["packageOriginId", "sessionNumber", "addonOf", "bookingKind", "totalSessions", "status"]) {
      expect(written()).not.toHaveProperty(f);
    }
  });

  it("reassigning keeps done sessions and an older paid tick with the therapist who did them", async () => {
    appt.status = "scheduled";
    appt.quotedPrice = 4000;
    appt.therapistSplitPercent = 50;
    appt.therapistPaidAt = "2026-10-01T10:00:00.000Z";
    appt.sessionNotes = [{ session: 1, therapist: "Asha", at: "2026-10-01T09:00:00.000Z" }];
    const r = res();
    await updateAppointment(put("ADMIN", { doctorId: "THR-2" }), r);
    expect(written().sessionNotes).toEqual([expect.objectContaining({ session: 1, doctorId: "THR-1", splitPercent: 50 })]);
    expect(written().therapistPayouts).toEqual([expect.objectContaining({ doctorId: "THR-1", amount: 2000 })]);
  });

  it("a finished visit keeps its therapist; reassigning an open one clears the old split", async () => {
    appt.status = "completed";
    let r = res();
    await updateAppointment(put("ADMIN", { doctorId: "THR-2" }), r);
    expect(r.status).toHaveBeenCalledWith(400);

    appt.status = "scheduled";
    appt.therapistSplitPercent = 60;
    r = res();
    await updateAppointment(put("ADMIN", { doctorId: "THR-2" }), r);
    expect(written()).toMatchObject({ doctorId: "THR-2", therapistSplitPercent: null });
  });

  it("history is append-only: stored entries survive, new ones are added", async () => {
    const added = { at: "2026-10-30T10:00:00.000Z", userId: "t1", name: "T", action: "Arrived" };
    const r = res();
    // The client drops the stored entry and adds one.
    await updateAppointment(put("THERAPIST", { status: "ongoing", activityLog: [added] }), r);
    expect(written().activityLog).toEqual([appt.activityLog[0], added]);
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

  it("never files the customer's enquiry note as the therapist's session note", async () => {
    appt.note = "Customer: back pain for two weeks";
    const r = res();
    await completeSession(done({ performed: true }), r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect((r.send as any).mock.calls[0][0].message).toBe("Tick Service performed and write the session note first.");
  });

  it("a draft saved from the Visit tab counts as the note, and completion clears only the draft", async () => {
    appt.note = "Customer: back pain for two weeks";
    appt.sessionNoteDraft = "Lower back, dry needling";
    const r = res();
    await completeSession(done({ performed: true }), r);
    expect((r.send as any).mock.calls[0]?.[0]?.message).not.toBe("Tick Service performed and write the session note first.");
    const writes = mockFindOneAndUpdate.mock.calls.map((c) => c[1]);
    const final = writes.find((u: any) => u && "sessionNoteDraft" in u);
    expect(final).toBeDefined();
    expect(final.sessionNoteDraft).toBe("");
    expect(final).not.toHaveProperty("note");
    expect(final.$push.sessionNotes.note).toBe("Lower back, dry needling");
  });

  it("a single visit is announced as a visit, not a package", async () => {
    appt.sessionNoteDraft = "Knee mobilisation";
    appt.sessionsCompleted = 1; // what the session-count bump returns for a one-visit booking
    const r = res();
    await completeSession(done({ performed: true }), r);
    expect((r.send as any).mock.calls[0][0]).toMatchObject({ success: true, message: "Visit completed" });
  });

  it("refuses to complete until this visit's payment is collected (moved here from the start)", async () => {
    appt.quotedPrice = 1600;
    appt.paymentAmount = 600; // ₹1,000 still owed on this visit
    const r = res();
    await completeSession(done({ performed: true, note: "Lower back, dry needling" }), r);
    expect(r.status).toHaveBeenCalledWith(402);
    expect((r.send as any).mock.calls[0][0]).toMatchObject({ short: 1000 });
    expect((r.send as any).mock.calls[0][0].message).toMatch(/before completing this visit/);
  });
});
