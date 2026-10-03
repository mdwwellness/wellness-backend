import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const { mockFindOneAndUpdate } = vi.hoisted(() => ({ mockFindOneAndUpdate: vi.fn() }));
vi.mock("../models/doctorsModel.ts", () => ({
  Doctor: { findOne: vi.fn(), findOneAndUpdate: mockFindOneAndUpdate },
}));
vi.mock("../models/userModel.ts", () => ({
  default: { findOne: vi.fn() },
}));
vi.mock("../models/appointmentsBookingModel.ts", () => ({ default: {} }));
vi.mock("../models/therapistLeaveModel.ts", () => ({ TherapistLeave: {} }));
vi.mock("../lib/logger.ts", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/counters.ts", () => ({ nextSequence: vi.fn() }));

import { addDoctor, updateDoctorDetails } from "./DoctorController.ts";

function mockReq(body: any = {}) {
  return { body } as unknown as Request;
}

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as unknown as Response;
}

describe("addDoctor - input validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a request missing name/email/phone with a clean 400, not a crash", async () => {
    const req = mockReq({ password: "password123" }); // no name, email, or phonenumber
    const res = mockRes();

    await addDoctor(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: "Name, email and phone number are required.",
      })
    );
  });

  it("rejects a password shorter than 6 characters", async () => {
    const req = mockReq({
      name: "Dr. Reddy",
      email: "reddy@example.com",
      phonenumber: "9999999999",
      password: "abc",
    });
    const res = mockRes();

    await addDoctor(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: expect.stringContaining("password"),
      })
    );
  });

  it("requires an earnings split when an admin adds a therapist", async () => {
    const req = {
      ...mockReq({
        name: "Dr. Reddy",
        email: "reddy@example.com",
        phonenumber: "9999999999",
        password: "password123",
      }),
      user: { role: "ADMIN" },
    } as unknown as Request;
    const res = mockRes();

    await addDoctor(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("split") })
    );
  });
});

describe("updateDoctorDetails - earnings split", () => {
  const updateReq = (role: string, body: any) =>
    ({ params: { id: "THR-0001" }, body, user: { role } }) as unknown as Request;
  /** The update object passed to Doctor.findOneAndUpdate. */
  const savedUpdate = () => mockFindOneAndUpdate.mock.calls[0][1];

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOneAndUpdate.mockResolvedValue({ doctorId: "THR-0001" });
  });

  it("lets an admin set a therapist's split", async () => {
    await updateDoctorDetails(updateReq("ADMIN", { splitPercent: 70 }), mockRes());
    expect(savedUpdate().splitPercent).toBe(70);
  });

  it("drops a split sent by a therapist, so they can't raise their own cut", async () => {
    await updateDoctorDetails(updateReq("THERAPIST", { name: "T", splitPercent: 100 }), mockRes());
    expect(savedUpdate()).not.toHaveProperty("splitPercent");
    expect(savedUpdate().name).toBe("T");
  });

  it("rejects an out-of-range split from an admin", async () => {
    const res = mockRes();
    await updateDoctorDetails(updateReq("SUPER_ADMIN", { splitPercent: 150 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
