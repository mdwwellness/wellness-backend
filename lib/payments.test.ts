import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindOneAndUpdate, mockFindById } = vi.hoisted(() => ({
  mockFindOneAndUpdate: vi.fn(),
  mockFindById: vi.fn(),
}));
vi.mock("../models/appointmentsBookingModel.ts", () => ({
  default: { findOneAndUpdate: mockFindOneAndUpdate, findById: mockFindById },
}));
vi.mock("../models/doctorsModel.ts", () => ({ Doctor: { findOne: vi.fn() } }));

import { paidNeededBeforeVisit, recordPayment } from "./payments.ts";

describe("paidNeededBeforeVisit", () => {
  it("a single visit needs its full fee", () => {
    expect(paidNeededBeforeVisit({}, { quotedPrice: 1600 })).toBe(1600);
  });

  it("session 3 of a 9-session course needs 3/9 of the price", () => {
    const course = { quotedPrice: 9000, totalSessions: 9 };
    expect(paidNeededBeforeVisit({ packageOriginId: "a", sessionNumber: 3 }, course)).toBe(3000);
    // One-row course: the next session is completed + 1.
    expect(paidNeededBeforeVisit({ sessionsCompleted: 2 }, course)).toBe(3000);
  });
});

describe("recordPayment", () => {
  const row = { _id: "a1", quotedPrice: 1600, paymentAmount: 600 };
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOneAndUpdate.mockReturnValue({ exec: () => Promise.resolve({ ...row, paymentAmount: 1600 }) });
  });

  it("adds to what's paid and marks it fully paid when the balance is cleared", async () => {
    const r = await recordPayment({ row, amount: 1000, method: "cash", user: { role: "THERAPIST", userfName: "T" } });
    expect(r.ok).toBe(true);
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: "a1", paymentAmount: 600 });
    expect(update.$inc).toEqual({ paymentAmount: 1000 });
    expect(update.$set.paymentReceived).toBe(true);
    expect(update.$push.payments).toMatchObject({ amount: 1000, method: "cash", by: "T", byRole: "THERAPIST" });
  });

  it("a part-payment leaves it unpaid", async () => {
    await recordPayment({ row: { ...row, paymentAmount: 0 }, amount: 600, method: "upi" });
    expect(mockFindOneAndUpdate.mock.calls[0][1].$set.paymentReceived).toBe(false);
  });

  it("never takes more than is due, nor zero", async () => {
    expect(await recordPayment({ row, amount: 1001, method: "cash" })).toMatchObject({ ok: false, code: 400 });
    expect(await recordPayment({ row, amount: 0, method: "cash" })).toMatchObject({ ok: false, code: 400 });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("a course follow-up row pays into the course's first row", async () => {
    mockFindById.mockReturnValue({ exec: () => Promise.resolve({ _id: "origin", quotedPrice: 9000, paymentAmount: 0 }) });
    await recordPayment({ row: { _id: "s3", packageOriginId: "origin" }, amount: 1000, method: "cash" });
    expect(mockFindOneAndUpdate.mock.calls[0][0]._id).toBe("origin");
  });
});
