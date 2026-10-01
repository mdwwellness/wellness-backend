import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const { mockFindOneAndUpdate } = vi.hoisted(() => ({
  mockFindOneAndUpdate: vi.fn(),
}));

vi.mock("../models/clinicSettingsModel.ts", () => ({
  default: {
    findOne: vi.fn(),
    create: vi.fn(),
    findOneAndUpdate: mockFindOneAndUpdate,
  },
}));

vi.mock("../lib/logger.ts", () => ({
  logger: { info: vi.fn() },
}));

import { updateClinicSettings } from "./clinicSettingsController.ts";

function mockReq(body: any = {}) {
  return { body } as unknown as Request;
}

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res as unknown as Response;
}

describe("updateClinicSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOneAndUpdate.mockResolvedValue({ bookingGapMinutes: 60 });
  });

  it("saves bookingGapMinutes", async () => {
    const req = mockReq({ bookingGapMinutes: 45 });
    const res = mockRes();

    await updateClinicSettings(req, res);

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { key: "global" },
      { $set: { bookingGapMinutes: 45 } },
      { new: true, upsert: true },
    );
  });

  it("ignores the removed global therapistSplitPercent", async () => {
    const req = mockReq({ therapistSplitPercent: 70 });
    const res = mockRes();

    await updateClinicSettings(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects a request with no recognized fields", async () => {
    const req = mockReq({});
    const res = mockRes();

    await updateClinicSettings(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
