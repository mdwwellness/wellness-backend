import { describe, it, expect } from "vitest";
import {
  computeOfferOff,
  offerIsApplicable,
  applicableOffers,
  roleAllows,
  offerMoney,
  type OfferContext,
  type OfferLike,
} from "./offers.ts";

/** Build a valid offer for tests, overriding only what each case needs. */
const offer = (over: Partial<OfferLike> = {}): OfferLike =>
  ({
    name: "Test offer",
    kind: "percent",
    amount: 10,
    ...over,
  }) as OfferLike;

const ctx = (over: Partial<OfferContext> = {}): OfferContext => ({
  userRole: "STAFF",
  lineKind: "main",
  ...over,
});

describe("roleAllows", () => {
  it("lets a role at or above the floor apply an offer", () => {
    expect(roleAllows("STAFF", "STAFF")).toBe(true);
    expect(roleAllows("ADMIN", "STAFF")).toBe(true);
    expect(roleAllows("SUPER_ADMIN", "ADMIN")).toBe(true);
  });
  it("blocks a role below the floor", () => {
    expect(roleAllows("STAFF", "ADMIN")).toBe(false);
    expect(roleAllows("ADMIN", "SUPER_ADMIN")).toBe(false);
  });
  it("never lets a therapist apply an offer", () => {
    expect(roleAllows("THERAPIST", "STAFF")).toBe(false);
  });
});

describe("computeOfferOff", () => {
  it("percent off the base", () => {
    expect(computeOfferOff(offer({ kind: "percent", amount: 10 }), 2000)).toEqual({
      off: 200,
      final: 1800,
      cappedByMax: false,
      clampedToBase: false,
    });
  });
  it("percent capped by maxOff", () => {
    const r = computeOfferOff(offer({ kind: "percent", amount: 20, maxOff: 300 }), 2000);
    expect(r.off).toBe(300); // 20% would be 400, capped to 300
    expect(r.final).toBe(1700);
    expect(r.cappedByMax).toBe(true);
  });
  it("fixed amount off the base", () => {
    expect(computeOfferOff(offer({ kind: "fixed", amount: 500 }), 1600)).toEqual({
      off: 500,
      final: 1100,
      cappedByMax: false,
      clampedToBase: false,
    });
  });
  it("fixed larger than base clamps to base (never negative)", () => {
    const r = computeOfferOff(offer({ kind: "fixed", amount: 5000 }), 1200);
    expect(r).toEqual({ off: 1200, final: 0, cappedByMax: false, clampedToBase: true });
  });
  it("percent above 100 hard-caps to the whole base", () => {
    const r = computeOfferOff(offer({ kind: "percent", amount: 150 }), 800);
    expect(r.off).toBe(800);
    expect(r.final).toBe(0);
  });
  it("zero or negative base is a no-op", () => {
    expect(computeOfferOff(offer(), 0)).toEqual({
      off: 0,
      final: 0,
      cappedByMax: false,
      clampedToBase: false,
    });
  });
  it("rounds to whole rupees", () => {
    expect(computeOfferOff(offer({ kind: "percent", amount: 15 }), 999).off).toBe(150);
  });
});

describe("offerIsApplicable", () => {
  it("applies when all gates pass", () => {
    expect(offerIsApplicable(offer(), 2000, ctx()).ok).toBe(true);
  });
  it("blocks an inactive offer", () => {
    const r = offerIsApplicable(offer({ active: false }), 2000, ctx());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/off/i);
  });
  it("blocks when the role is below the floor", () => {
    expect(
      offerIsApplicable(offer({ minRole: "ADMIN" }), 2000, ctx({ userRole: "STAFF" })).ok,
    ).toBe(false);
  });
  it("scopes courses-only offers away from the main line", () => {
    expect(offerIsApplicable(offer({ appliesTo: "courses" }), 2000, ctx({ lineKind: "main" })).ok).toBe(false);
    expect(offerIsApplicable(offer({ appliesTo: "courses" }), 2000, ctx({ lineKind: "course" })).ok).toBe(true);
  });
  it("respects a service allow-list", () => {
    const o = offer({ appliesTo: "services", serviceIds: ["SRV-1"] });
    expect(offerIsApplicable(o, 2000, ctx({ serviceId: "SRV-1" })).ok).toBe(true);
    expect(offerIsApplicable(o, 2000, ctx({ serviceId: "SRV-9" })).ok).toBe(false);
  });
  it("enforces the validity window", () => {
    const now = new Date("2026-10-22T00:00:00Z");
    expect(offerIsApplicable(offer({ validUntil: "2026-10-01T00:00:00Z" }), 2000, ctx({ now })).ok).toBe(false);
    expect(offerIsApplicable(offer({ validFrom: "2026-11-01T00:00:00Z" }), 2000, ctx({ now })).ok).toBe(false);
  });
  it("enforces the total-uses cap", () => {
    expect(offerIsApplicable(offer({ totalUses: 100, usedCount: 100 }), 2000, ctx()).ok).toBe(false);
  });
  it("enforces once-per-phone (default on)", () => {
    expect(offerIsApplicable(offer(), 2000, ctx({ phoneAlreadyUsed: true })).ok).toBe(false);
    expect(offerIsApplicable(offer({ oncePerPhone: false }), 2000, ctx({ phoneAlreadyUsed: true })).ok).toBe(true);
  });
  it("rejects an offer that would take nothing off", () => {
    expect(offerIsApplicable(offer({ amount: 0 }), 2000, ctx()).ok).toBe(false);
  });
});

describe("applicableOffers", () => {
  it("returns only the offers the user may apply to this line", () => {
    const list: OfferLike[] = [
      offer({ name: "staff-ok", minRole: "STAFF" }),
      offer({ name: "admin-only", minRole: "ADMIN" }),
      offer({ name: "off", active: false }),
    ];
    expect(applicableOffers(list, 2000, ctx({ userRole: "STAFF" })).map((o) => o.name)).toEqual(["staff-ok"]);
    expect(applicableOffers(list, 2000, ctx({ userRole: "ADMIN" })).map((o) => o.name)).toEqual(["staff-ok", "admin-only"]);
  });
});

describe("offerMoney (below-paid guard)", () => {
  it("allows a discount that keeps the final price at or above what's paid", () => {
    const r = offerMoney(offer({ kind: "percent", amount: 10 }), 2000, 500);
    expect(r).toMatchObject({ ok: true, off: 200, final: 1800 });
  });
  it("blocks a discount that would price below the amount already received", () => {
    const r = offerMoney(offer({ kind: "fixed", amount: 1700 }), 2000, 500);
    expect(r.ok).toBe(false);
    expect(r.final).toBe(300);
    expect(r.reason).toMatch(/below/i);
  });
  it("treats a zero/negative paid as no money in", () => {
    expect(offerMoney(offer({ kind: "fixed", amount: 500 }), 1600, 0).ok).toBe(true);
  });
});
