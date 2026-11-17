import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const { mockFindOne } = vi.hoisted(() => ({ mockFindOne: vi.fn() }));
vi.mock("../models/customerModel.ts", () => ({ default: { findOne: mockFindOne } }));
vi.mock("../lib/counters.ts", () => ({ nextSequence: vi.fn() }));
vi.mock("../lib/invoiceGeneration.ts", () => ({ formatCustomerId: vi.fn(), withPhoneLock: vi.fn() }));

import { updateCustomer } from "./customerController.ts";

function res() {
  const r: any = {};
  r.status = vi.fn().mockReturnValue(r);
  r.send = vi.fn().mockReturnValue(r);
  return r as Response & { status: any; send: any };
}
const patch = (role: string, body: object) =>
  ({ params: { customerId: "CUST-0108" }, body, user: { _id: "u1", role } }) as unknown as Request;

let customer: any;
beforeEach(() => {
  vi.clearAllMocks();
  customer = { customer_id: "CUST-0108", name: "mlaunch02", codBlocked: false, notes: [], save: vi.fn() };
  mockFindOne.mockReturnValue({ exec: async () => customer });
});

describe("COD blacklist on PATCH /api/customers/:id", () => {
  it.each(["SUPER_ADMIN", "ADMIN", "STAFF", "CUSTOMER_CARE"])("%s can block and allow cash", async (role) => {
    let r = res();
    await updateCustomer(patch(role, { codBlocked: true }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(customer.codBlocked).toBe(true);
    expect(customer.save).toHaveBeenCalled();

    r = res();
    await updateCustomer(patch(role, { codBlocked: false }), r);
    expect(customer.codBlocked).toBe(false);
  });

  it("a therapist can't change it, and nothing is saved", async () => {
    const r = res();
    await updateCustomer(patch("THERAPIST", { codBlocked: true }), r);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(customer.codBlocked).toBe(false);
    expect(customer.save).not.toHaveBeenCalled();
  });

  it("only true or false; other edits leave it as it is", async () => {
    let r = res();
    await updateCustomer(patch("ADMIN", { codBlocked: "yes" }), r);
    expect(r.status).toHaveBeenCalledWith(400);

    customer.codBlocked = true;
    r = res();
    await updateCustomer(patch("ADMIN", { email: "new@x.com" }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(customer.codBlocked).toBe(true);
  });
});
