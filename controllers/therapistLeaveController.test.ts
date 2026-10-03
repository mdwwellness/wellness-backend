import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const { mockFind } = vi.hoisted(() => ({
  mockFind: vi.fn(),
}));

vi.mock("../models/therapistLeaveModel.ts", () => ({
  TherapistLeave: { find: mockFind },
}));

vi.mock("../models/doctorsModel.ts", () => ({
  Doctor: { findOneAndUpdate: vi.fn() },
}));

import { getLeaves } from "./therapistLeaveController.ts";

function mockReq({ params = {}, query = {} }: { params?: any; query?: any }) {
  return { params, query } as unknown as Request;
}

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as unknown as Response;
}

function chainable() {
  const chain: any = {};
  chain.sort = vi.fn().mockReturnValue(chain);
  chain.lean = vi.fn().mockResolvedValue([]);
  return chain;
}

describe("getLeaves", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFind.mockReturnValue(chainable());
  });

  it("filters by doctorId from the path param (GET /:doctorId)", async () => {
    const req = mockReq({ params: { doctorId: "THR-0001" } });
    const res = mockRes();

    await getLeaves(req, res);

    expect(mockFind).toHaveBeenCalledWith({ doctorId: "THR-0001" });
  });

  it("still filters by doctorId from the query string (GET /?doctorId=)", async () => {
    const req = mockReq({ query: { doctorId: "THR-0002" } });
    const res = mockRes();

    await getLeaves(req, res);

    expect(mockFind).toHaveBeenCalledWith({ doctorId: "THR-0002" });
  });

  it("returns everything when neither is given", async () => {
    const req = mockReq({});
    const res = mockRes();

    await getLeaves(req, res);

    expect(mockFind).toHaveBeenCalledWith({});
  });
});
