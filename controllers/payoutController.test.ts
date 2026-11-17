import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const m = vi.hoisted(() => ({ balances: vi.fn(), own: vi.fn(), exists: vi.fn(), create: vi.fn() }));
vi.mock("../lib/payouts.ts", () => ({ payoutBalances: m.balances }));
vi.mock("../lib/payments.ts", () => ({ ownDoctorId: m.own }));
vi.mock("../models/doctorsModel.ts", () => ({ Doctor: { exists: m.exists } }));
vi.mock("../models/therapistSettlementModel.ts", () => ({ TherapistSettlement: { create: m.create } }));

import { addSettlement, getPayoutBalances } from "./payoutController.ts";

function res() {
  const r: any = {};
  r.status = vi.fn().mockReturnValue(r);
  r.send = vi.fn().mockReturnValue(r);
  return r as Response & { status: any; send: any };
}
const as = (role: string, body: object = {}) => ({ user: { role, userfName: "Ana", userlName: "Admin" }, body }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  m.balances.mockResolvedValue([{ doctorId: "A" }]);
  m.exists.mockResolvedValue(true);
  m.create.mockImplementation(async (d: any) => d);
});

describe("GET /api/payouts", () => {
  it("admins see every therapist, a therapist only themself, anyone else nothing", async () => {
    await getPayoutBalances(as("ADMIN"), res());
    expect(m.balances).toHaveBeenLastCalledWith();

    m.own.mockResolvedValue("THR-0004");
    await getPayoutBalances(as("THERAPIST"), res());
    expect(m.balances).toHaveBeenLastCalledWith("THR-0004");

    const r = res();
    await getPayoutBalances(as("STAFF"), r);
    expect(r.status).toHaveBeenCalledWith(403);
  });
});

describe("POST /api/payouts/settlements", () => {
  it("records a settlement, rounded to the rupee, with who recorded it", async () => {
    const r = res();
    await addSettlement(as("ADMIN", { doctorId: "THR-0004", amount: "640.4", direction: "received", note: " cash handed in " }), r);
    expect(r.status).toHaveBeenCalledWith(201);
    expect(m.create).toHaveBeenCalledWith({ doctorId: "THR-0004", amount: 640, direction: "received", note: "cash handed in", by: "Ana Admin" });
  });

  it("refuses a zero or junk amount, an unknown direction, and an unknown therapist", async () => {
    for (const body of [
      { doctorId: "THR-0004", amount: 0, direction: "paid" },
      { doctorId: "THR-0004", amount: "abc", direction: "paid" },
      { doctorId: "THR-0004", amount: 100, direction: "gift" },
    ]) {
      const r = res();
      await addSettlement(as("ADMIN", body), r);
      expect(r.status).toHaveBeenCalledWith(400);
    }
    m.exists.mockResolvedValue(false);
    const r = res();
    await addSettlement(as("ADMIN", { doctorId: "THR-9999", amount: 100, direction: "paid" }), r);
    expect(r.status).toHaveBeenCalledWith(404);
    expect(m.create).not.toHaveBeenCalled();
  });
});
