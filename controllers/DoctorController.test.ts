import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("../models/doctorsModel.ts", () => ({
  Doctor: { findOne: vi.fn() },
}));
vi.mock("../models/userModel.ts", () => ({
  default: { findOne: vi.fn() },
}));
vi.mock("../models/appointmentsBookingModel.ts", () => ({ default: {} }));
vi.mock("../models/therapistLeaveModel.ts", () => ({ TherapistLeave: {} }));
vi.mock("../lib/logger.ts", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/counters.ts", () => ({ nextSequence: vi.fn() }));

import { addDoctor } from "./DoctorController.ts";

function mockReq(body: any = {}) {
  return { body } as unknown as Request;
}

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
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
});
