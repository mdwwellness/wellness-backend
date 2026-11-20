import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const m = vi.hoisted(() => ({ findOne: vi.fn(), count: vi.fn(), doctorFindOne: vi.fn() }));
vi.mock("../models/appointmentsBookingModel.ts", () => ({
  default: { findOne: m.findOne, countDocuments: m.count },
}));
vi.mock("../models/doctorsModel.ts", () => ({ Doctor: { findOne: m.doctorFindOne } }));
vi.mock("../models/customerModel.ts", () => ({ default: {} }));
vi.mock("../models/therapistLeaveModel.ts", () => ({ TherapistLeave: {} }));
vi.mock("../models/serviceModel.ts", () => ({ default: {} }));
vi.mock("../lib/logger.ts", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock("../lib/counters.ts", () => ({ nextSequence: vi.fn() }));
vi.mock("../lib/invoiceGeneration.ts", () => ({ safeSyncInvoiceFromAppointment: vi.fn() }));

import { getBookingsVersion } from "./appointmentController.ts";

function res() {
  const r: any = {};
  r.status = vi.fn().mockReturnValue(r);
  r.send = vi.fn().mockReturnValue(r);
  r.json = vi.fn().mockReturnValue(r);
  return r as Response & { status: any; send: any; json: any };
}
const req = (role: string) => ({ user: { _id: "u1", role, userEmail: "t@x.com" } }) as unknown as Request;
const latestAt = new Date("2026-11-19T10:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  m.findOne.mockReturnValue({ sort: () => ({ lean: async () => ({ updatedAt: latestAt }) }) });
  m.count.mockResolvedValue(190);
  m.doctorFindOne.mockReturnValue({ lean: async () => ({ doctorId: "THR-0004" }) });
});

describe("GET /api/appointments/version: a tiny fingerprint of the bookings a login can see", () => {
  it("the office: count and newest change across every booking", async () => {
    const r = res();
    await getBookingsVersion(req("STAFF"), r);
    expect(r.send).toHaveBeenCalledWith({ success: true, data: { version: `190-${latestAt.getTime()}` } });
    expect(m.findOne).toHaveBeenCalledWith({}, { updatedAt: 1 });
    expect(m.count).toHaveBeenCalledWith({});
  });

  it("a therapist: only their own bookings, the same scope as their list", async () => {
    const r = res();
    await getBookingsVersion(req("THERAPIST"), r);
    expect(m.findOne).toHaveBeenCalledWith({ doctorId: "THR-0004" }, { updatedAt: 1 });
    expect(m.count).toHaveBeenCalledWith({ doctorId: "THR-0004" });
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it("a therapist login with no profile sees nothing, and any other role is refused", async () => {
    m.doctorFindOne.mockReturnValue({ lean: async () => null });
    let r = res();
    await getBookingsVersion(req("THERAPIST"), r);
    expect(r.send).toHaveBeenCalledWith({ success: true, data: { version: "0-0" } });
    expect(m.count).not.toHaveBeenCalled();

    r = res();
    await getBookingsVersion(req("CUSTOMER"), r);
    expect(r.status).toHaveBeenCalledWith(403);
  });

  it("no bookings yet still gives a stable version", async () => {
    m.findOne.mockReturnValue({ sort: () => ({ lean: async () => null }) });
    m.count.mockResolvedValue(0);
    const r = res();
    await getBookingsVersion(req("ADMIN"), r);
    expect(r.send).toHaveBeenCalledWith({ success: true, data: { version: "0-0" } });
  });
});
