import { describe, it, expect, vi } from "vitest";

const { mockFind } = vi.hoisted(() => ({ mockFind: vi.fn() }));
vi.mock("../models/customerModel.ts", () => ({ default: { find: mockFind } }));

import { withCodBlock } from "./codBlock.ts";

describe("withCodBlock: a blacklisted customer's bookings carry the tag", () => {
  it("marks their bookings by customer ID or by phone + name, and leaves everyone else alone", async () => {
    mockFind.mockReturnValue({ lean: async () => [{ customer_id: "CUST-0108", phone: 9089039839, name: "mlaunch02" }] });
    const rows = [
      { enquiryId: "ENQ-0178", customer_id: "CUST-0108", phonenumber: 9089039839, name: "mlaunch02" },
      // A course follow-up: no customer ID, same person.
      { enquiryId: "ENQ-0179", phonenumber: 9089039839, name: "MLAUNCH02 " },
      // Same household phone, another person.
      { enquiryId: "ENQ-0180", phonenumber: 9089039839, name: "Asha" },
      { enquiryId: "ENQ-0181", customer_id: "CUST-0001", phonenumber: 9000000000, name: "Ravi" },
    ];
    const out = await withCodBlock(rows);
    expect(out.map((r: any) => r.codBlocked ?? false)).toEqual([true, true, false, false]);
    expect(mockFind).toHaveBeenCalledWith({ codBlocked: true }, { customer_id: 1, phone: 1, name: 1 });
    expect(out[2]).toBe(rows[2]); // untouched rows are passed through as they are
  });

  it("no one blacklisted: nothing changes", async () => {
    mockFind.mockReturnValue({ lean: async () => [] });
    const rows = [{ enquiryId: "ENQ-0001", phonenumber: 9000000000, name: "Ravi" }];
    expect(await withCodBlock(rows)).toEqual(rows);
  });
});
