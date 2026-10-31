import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindOneAndUpdate, mockFind, mockDoctorFind } = vi.hoisted(() => ({
  mockFindOneAndUpdate: vi.fn(),
  mockFind: vi.fn(),
  mockDoctorFind: vi.fn(),
}));
vi.mock("../models/appointmentsBookingModel.ts", () => ({
  default: { findOneAndUpdate: mockFindOneAndUpdate, find: mockFind, findById: vi.fn() },
}));
vi.mock("../models/doctorsModel.ts", () => ({ Doctor: { find: mockDoctorFind } }));

import { cutOf, payoutOf, recordPayout, withPayouts } from "./payouts.ts";

const ctx = (rows: any[] = [], splits: Record<string, number | null> = {}) => ({
  byId: new Map(rows.map((r) => [String(r._id), r])),
  splits: new Map(Object.entries(splits)),
});
const part = (r: any, c: any, doctorId = r.doctorId) => payoutOf(r, c).find((p) => p.doctorId === doctorId)!;

// A 5-session ₹5,000 course booked a visit per session: A (60%) does session 1, B (50%) the rest.
const origin = {
  _id: "o1", bookingKind: "course", totalSessions: 5, sessionIntervalDays: 7, quotedPrice: 5000,
  paymentAmount: 5000, paymentReceived: true, doctorId: "A", doctor: "Asha", therapistSplitPercent: 60, status: "completed",
};
const followUp = (n: number, status = "completed") => ({
  _id: `f${n}`, packageOriginId: "o1", sessionNumber: n, totalSessions: 5, quotedPrice: 1000,
  doctorId: "B", doctor: "Bina", therapistSplitPercent: status === "completed" ? 50 : undefined, status,
});

describe("payoutOf - courses are earned per session (#49)", () => {
  it("each session earns its share at the % of whoever did it", () => {
    const rows = [origin, followUp(2), followUp(3), followUp(4), followUp(5)];
    const c = ctx(rows, { A: 60, B: 50 });
    expect(part(origin, c).earned).toMatchObject({ revenue: 1000, therapistCut: 600, companyCut: 400 });
    const b = rows.slice(1).map((r) => part(r, c).earned.therapistCut);
    expect(b.reduce((t, x) => t + x, 0)).toBe(2000);
    // Nothing is left pending on a fully paid, fully done course.
    expect(rows.every((r) => part(r, c).pending.due === 0)).toBe(true);
  });

  it("an undone follow-up is upcoming at its share, never extra money", () => {
    const f = followUp(2, "scheduled");
    const p = part(f, ctx([origin], { B: 50 }));
    // Paid in advance on session 1's row, so nothing is due on it.
    expect(p.upcoming).toMatchObject({ revenue: 1000, therapistCut: 500, companyCut: 500, due: 0 });
    expect(p.earned.revenue).toBe(0);
  });

  it("pay as you go: a session done and paid is earned; done but unpaid is pending with what's due", () => {
    const paced = { ...origin, quotedPrice: 9000, totalSessions: 9, paymentAmount: 1000, paymentReceived: false };
    expect(part(paced, ctx([], { A: 60 })).earned.revenue).toBe(1000);
    const f2 = { ...followUp(2), totalSessions: 9 };
    const p = part(f2, ctx([paced], { B: 50 }));
    expect(p.earned.revenue).toBe(0);
    expect(p.pending).toMatchObject({ revenue: 1000, due: 1000 });
  });
});

describe("payoutOf - packages kept on one row (#57, #56)", () => {
  const pkg = {
    _id: "p1", totalSessions: 4, quotedPrice: 4000, paymentAmount: 4000, paymentReceived: true,
    sessionsCompleted: 2, status: "scheduled", doctorId: "B", doctor: "Bina", therapistSplitPercent: null,
    sessionNotes: [
      { session: 1, doctorId: "A", therapist: "Asha", splitPercent: 60, at: "2026-10-01T10:00:00.000Z" },
      { session: 2, doctorId: "B", therapist: "Bina", splitPercent: 50, at: "2026-10-08T10:00:00.000Z" },
    ],
  };

  it("earns each session as it's done, not all at the last one", () => {
    const parts = payoutOf(pkg, ctx([], { B: 50 }));
    const a = parts.find((p) => p.doctorId === "A")!;
    const b = parts.find((p) => p.doctorId === "B")!;
    expect(a.earned).toMatchObject({ revenue: 1000, therapistCut: 600, companyCut: 400 });
    expect(b.earned.therapistCut).toBe(500);
    expect(b.upcoming.revenue).toBe(2000);
    expect(a.sessions + b.sessions).toBe(2);
  });

  it("older sessions without a stamp fall back to the row's therapist and lock", () => {
    const old = { ...pkg, therapistSplitPercent: 40, sessionNotes: [] };
    expect(part(old, ctx([], { B: 70 })).earned.therapistCut).toBe(800); // 2 × 1000 × 40%
  });
});

describe("payoutOf - add-ons are earned by whoever did them (#50)", () => {
  const host = {
    _id: "h1", quotedPrice: 1000, paymentAmount: 1000, paymentReceived: true, status: "completed",
    doctorId: "A", doctor: "Asha", therapistSplitPercent: 60,
    sessionNotes: [{ session: 1, doctorId: "A", splitPercent: 60, at: "2026-10-01T11:00:00.000Z" }],
    recommendedServices: [
      // Same visit: done in the host visit.
      { serviceId: "S1", recommendedAt: "2026-10-01T10:30:00.000Z", serviceName: "Cupping", quotedPrice: 500, status: "confirmed", firstInVisit: true, paidAmount: 500 },
      // Two sessions, both on later visits.
      { serviceId: "S2", recommendedAt: "2026-10-01T10:40:00.000Z", serviceName: "Dry needling", quotedPrice: 2000, sessions: 2, status: "confirmed", firstInVisit: false, paidAmount: 2000 },
      { serviceId: "S3", recommendedAt: "2026-10-01T10:50:00.000Z", serviceName: "Not agreed", quotedPrice: 900, status: "pending" },
    ],
  };

  it("a same-visit add-on goes to the visit's therapist; an unconfirmed one earns nothing", () => {
    expect(part(host, ctx([], { A: 60 })).earned).toMatchObject({ revenue: 1500, therapistCut: 900, companyCut: 600 });
  });

  it("an add-on visit earns its session for the therapist who did it", () => {
    const visit = { _id: "v1", addonOf: { bookingId: "h1", key: "S2|2026-10-01T10:40:00.000Z", session: 1 }, doctorId: "B", therapistSplitPercent: 50, status: "completed" };
    expect(part(visit, ctx([host], { B: 50 })).earned).toMatchObject({ revenue: 1000, therapistCut: 500, companyCut: 500 });
  });
});

describe("cutOf - offers follow absorbedBy (#47) and rounding (#58)", () => {
  it("company absorbs: the therapist is paid on the pre-offer price", () => {
    expect(cutOf({ amount: 1600, base: 2000, off: 400, absorbedBy: "company", split: 60 }))
      .toEqual({ revenue: 1600, therapistCut: 1200, companyCut: 400 });
  });
  it("therapist absorbs: the discount comes out of their share, never below 0", () => {
    expect(cutOf({ amount: 1600, base: 2000, off: 400, absorbedBy: "therapist", split: 60 }).therapistCut).toBe(800);
    expect(cutOf({ amount: 0, base: 2000, off: 2000, absorbedBy: "therapist", split: 60 }).therapistCut).toBe(0);
  });
  it("no offer: the paid price is split", () => {
    expect(cutOf({ amount: 1000, split: 60 })).toEqual({ revenue: 1000, therapistCut: 600, companyCut: 400 });
  });
  it("no split known: nothing to the therapist", () => {
    expect(cutOf({ amount: 1000, split: null })).toEqual({ revenue: 1000, therapistCut: 0, companyCut: 1000 });
  });
  it("a decimal split rounds half up, not down by float error", () => {
    expect(cutOf({ amount: 250, split: 64.6 }).therapistCut).toBe(162);
    expect(cutOf({ amount: 375, split: 9.2 }).therapistCut).toBe(35);
  });
  it("therapist + company always equals the amount", () => {
    for (let amount = 0; amount <= 3000; amount += 7) {
      for (const split of [0, 12.5, 33.3, 50, 64.6, 99.9, 100]) {
        const c = cutOf({ amount, split });
        expect(c.therapistCut + c.companyCut).toBe(amount);
      }
    }
  });
  it("an offer on a course is shared across its sessions, discount included", () => {
    const course = { ...origin, quotedPrice: 4000, appliedOffers: [{ lineKind: "main", base: 5000, off: 1000, absorbedBy: "company" }] };
    expect(part(course, ctx([], { A: 60 })).earned).toMatchObject({ revenue: 800, therapistCut: 600, companyCut: 200, discount: 200 });
  });
  it("an older row's discount (originalPrice above the price) still shows, without changing the cut", () => {
    const old = { _id: "d1", quotedPrice: 1500, originalPrice: 1600, paymentAmount: 1500, paymentReceived: true, status: "completed", doctorId: "A", therapistSplitPercent: 60 };
    expect(part(old, ctx()).earned).toMatchObject({ revenue: 1500, therapistCut: 900, discount: 100 });
  });
});

describe("payoutOf - payouts paid and owed (#53, #54)", () => {
  const visit = { _id: "x1", quotedPrice: 1000, paymentAmount: 1000, paymentReceived: true, status: "completed", doctorId: "A", therapistSplitPercent: 60 };

  it("the ledger is what was paid; any later difference shows as owed", () => {
    const p = part({ ...visit, therapistPayouts: [{ doctorId: "A", amount: 500 }] }, ctx());
    expect(p).toMatchObject({ paidOut: 500, owed: 100 });
  });
  it("an older row's tick covered whatever was earned", () => {
    expect(part({ ...visit, therapistPaid: true }, ctx())).toMatchObject({ paidOut: 600, owed: 0 });
  });
  it("an unlocked row follows the therapist's current split until it's paid", () => {
    expect(part({ ...visit, therapistSplitPercent: null }, ctx([], { A: 50 })).earned.therapistCut).toBe(500);
  });
  it("a booking cancelled before anything was done earns nothing; a bare lead lists nothing", () => {
    expect(payoutOf({ ...visit, status: "cancelled" }, ctx())).toEqual([]);
    expect(payoutOf({ _id: "e1", status: "enquiry" }, ctx())).toEqual([]);
  });

  it("a package cancelled part-way keeps the sessions done and what was paid out", () => {
    const pkg = {
      _id: "p9", totalSessions: 4, quotedPrice: 4000, paymentAmount: 4000, paymentReceived: true, sessionsCompleted: 2,
      status: "cancelled", doctorId: "A", therapistSplitPercent: 60, therapistPayouts: [{ doctorId: "A", amount: 1200 }],
    };
    expect(part(pkg, ctx())).toMatchObject({ sessions: 2, earned: { revenue: 2000, therapistCut: 1200 }, upcoming: { revenue: 0 }, paidOut: 1200, owed: 0 });
  });

  it("an older tick is valued at what the old page paid: the split × the row's own money", () => {
    // The old page paid 60% of the whole ₹5,000 course on session 1's row.
    const p = part({ ...origin, therapistPaid: true }, ctx([], { A: 60 }));
    expect(p).toMatchObject({ paidOut: 3000, owed: -2400 });
  });

  it("only sessions counted by checkout are done, not a package marked completed by hand", () => {
    const pkg = { _id: "p8", totalSessions: 10, quotedPrice: 10000, paymentAmount: 10000, paymentReceived: true, sessionsCompleted: 1, status: "completed", doctorId: "A", therapistSplitPercent: 60 };
    expect(part(pkg, ctx())).toMatchObject({ sessions: 1, earned: { therapistCut: 600 } });
    // An older row completed by hand with no count at all still counts as done.
    expect(part({ ...pkg, sessionsCompleted: 0 }, ctx()).sessions).toBe(10);
  });
});

describe("withPayouts - who sees what", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFind.mockReturnValue({ lean: () => Promise.resolve([]) });
    mockDoctorFind.mockReturnValue({ lean: () => Promise.resolve([{ doctorId: "A", splitPercent: 60 }, { doctorId: "B", splitPercent: 50 }]) });
  });
  const shared = {
    _id: "p2", totalSessions: 2, quotedPrice: 2000, paymentAmount: 2000, paymentReceived: true, sessionsCompleted: 2,
    status: "completed", doctorId: "B",
    sessionNotes: [{ session: 1, doctorId: "A", splitPercent: 60 }, { session: 2, doctorId: "B", splitPercent: 50 }],
  };

  it("an admin sees every part with its split", async () => {
    const [row] = await withPayouts([shared], { role: "ADMIN" });
    expect(row.payout.map((p: any) => [p.doctorId, p.splitPercent])).toEqual([["A", 60], ["B", 50]]);
  });
  it("a therapist sees only their own part, without the split", async () => {
    const [row] = await withPayouts([shared], { role: "THERAPIST", doctorId: "B" });
    expect(row.payout).toHaveLength(1);
    expect(row.payout[0]).toMatchObject({ doctorId: "B", earned: { therapistCut: 500 } });
    expect(row.payout[0]).not.toHaveProperty("splitPercent");
  });

  it("no split reaches Staff through the row's own fields either", async () => {
    const [row] = await withPayouts([{ ...shared, therapistSplitPercent: 50, therapistPayouts: [{ doctorId: "A", amount: 600 }] }], { role: "STAFF" });
    expect(row).not.toHaveProperty("therapistSplitPercent");
    expect(row).not.toHaveProperty("therapistPayouts");
    expect(row.sessionNotes.every((s: any) => !("splitPercent" in s))).toBe(true);
    expect(row.payout.find((p: any) => p.doctorId === "A")).toMatchObject({ paidOut: 600 });
  });
});

describe("recordPayout", () => {
  const row = { _id: "x1", quotedPrice: 1000, paymentAmount: 1000, paymentReceived: true, status: "completed", doctorId: "A", therapistSplitPercent: null };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFind.mockReturnValue({ lean: () => Promise.resolve([]) });
    mockDoctorFind.mockReturnValue({ lean: () => Promise.resolve([{ doctorId: "A", splitPercent: 60 }]) });
    mockFindOneAndUpdate.mockReturnValue({ exec: () => Promise.resolve({ ok: 1 }) });
  });

  it("pays what's owed, from the server, and locks the split it was paid at", async () => {
    const r = await recordPayout({ row, paid: true, user: { userfName: "Ana", userlName: "Admin" } });
    expect(r.ok).toBe(true);
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(filter.$expr).toBeDefined(); // only if nobody paid in between
    expect(update.$push.therapistPayouts.$each).toEqual([expect.objectContaining({ doctorId: "A", amount: 600, by: "Ana Admin" })]);
    expect(update.$set).toEqual({ therapistSplitPercent: 60 });
  });

  it("refuses when nothing is owed, and undoes only what was paid", async () => {
    const paid = { ...row, therapistPayouts: [{ doctorId: "A", amount: 600 }] };
    expect(await recordPayout({ row: paid, paid: true })).toMatchObject({ ok: false, code: 400 });
    await recordPayout({ row: paid, paid: false });
    expect(mockFindOneAndUpdate.mock.calls[0][1].$push.therapistPayouts.$each).toEqual([expect.objectContaining({ amount: -600 })]);
  });

  it("an older row's tick is carried into the ledger before it's undone", async () => {
    await recordPayout({ row: { ...row, therapistPaid: true }, paid: false });
    const entries = mockFindOneAndUpdate.mock.calls[0][1].$push.therapistPayouts.$each;
    expect(entries.map((e: any) => e.amount)).toEqual([600, -600]);
  });

  it("the tick is kept for its therapist even when someone else is paid first", async () => {
    mockDoctorFind.mockReturnValue({ lean: () => Promise.resolve([{ doctorId: "A", splitPercent: 60 }, { doctorId: "B", splitPercent: 50 }]) });
    const shared = {
      _id: "p3", totalSessions: 2, quotedPrice: 2000, paymentAmount: 2000, paymentReceived: true, sessionsCompleted: 2, status: "scheduled",
      doctorId: "B", therapistSplitPercent: 50, therapistPaid: true,
      sessionNotes: [{ session: 1, doctorId: "A", splitPercent: 60 }, { session: 2, doctorId: "B", splitPercent: 50 }],
    };
    await recordPayout({ row: shared, doctorId: "A", paid: true });
    const entries = mockFindOneAndUpdate.mock.calls[0][1].$push.therapistPayouts.$each;
    expect(entries.map((e: any) => [e.doctorId, e.amount])).toEqual([["B", 1000], ["A", 600]]);
  });

  it("says so when the write lost a race", async () => {
    mockFindOneAndUpdate.mockReturnValue({ exec: () => Promise.resolve(null) });
    expect(await recordPayout({ row, paid: true })).toMatchObject({ ok: false, code: 409 });
  });
});
