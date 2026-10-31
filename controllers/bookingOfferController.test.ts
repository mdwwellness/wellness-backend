import { describe, it, expect, vi, beforeEach } from "vitest";

// One unpaid ₹600 consultation and one fixed ₹60 offer.
const m = vi.hoisted(() => ({ booking: null as any, synced: [] as any[], usedOn: null as string | null }));

vi.mock("../models/appointmentsBookingModel.ts", () => ({
  default: {
    findById: () => ({ exec: async () => m.booking }),
    findOne: () => ({ select: () => ({ lean: async () => (m.usedOn ? { enquiryId: m.usedOn } : null) }) }),
    findOneAndUpdate: (_q: any, update: any) => ({
      exec: async () => {
        m.booking = { ...m.booking, ...update.$set, appliedOffers: update.$push?.appliedOffers ? [update.$push.appliedOffers] : [], activityLog: update.$push?.activityLog ? [update.$push.activityLog] : [] };
        return m.booking;
      },
    }),
  },
}));
const OFFER = { _id: "o1", name: "Diwali", code: "DIWALI", kind: "fixed", amount: 60, active: true, appliesTo: "all", minRole: "STAFF", oncePerPhone: false, toObject() { return this; } };
vi.mock("../models/offerModel.ts", () => ({
  default: {
    findOne: () => ({ exec: async () => OFFER }),
    findOneAndUpdate: () => ({ exec: async () => OFFER }),
  },
}));
vi.mock("../lib/invoiceGeneration.ts", () => ({
  safeSyncInvoiceFromAppointment: async (args: any) => void m.synced.push(args.appointment.quotedPrice),
}));
vi.mock("../lib/logger.ts", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { applyOffer, removeOffer } from "./bookingOfferController.ts";

function res() {
  const r: any = {};
  r.status = (c: number) => ((r.code = c), r);
  r.send = (b: any) => ((r.body = b), r);
  return r;
}
const req = (body: object, role = "ADMIN") => ({ params: { bookingId: "b1" }, body, user: { role, userfName: "Asha" } }) as any;

beforeEach(() => {
  m.booking = { _id: "b1", name: "launchman01", phonenumber: 9876500001, typeOfappointment: "consultation", quotedPrice: 600, paymentAmount: 0, appliedOffers: [], recommendedServices: [] };
  m.synced.length = 0;
  m.usedOn = null;
  OFFER.oncePerPhone = false;
});

describe("offers reach the invoice (ISSUES #42)", () => {
  it("applying an offer re-prices the booking's invoice", async () => {
    const r = res();
    await applyOffer(req({ offerId: "o1" }), r);
    expect(r.code).toBe(200);
    expect(m.synced).toEqual([540]);
  });

  it("removing an offer re-prices it back", async () => {
    await applyOffer(req({ offerId: "o1" }), res());
    const r = res();
    await removeOffer(req({ lineKind: "main" }), r);
    expect(r.code).toBe(200);
    expect(m.synced).toEqual([540, 600]);
  });
});

describe("paid in full follows the new price (ISSUES #55)", () => {
  it("an offer down to exactly what was paid settles the booking, and removing it reopens it", async () => {
    m.booking.paymentAmount = 540;
    m.booking.paymentReceived = false;
    await applyOffer(req({ offerId: "o1" }), res());
    expect(m.booking).toMatchObject({ quotedPrice: 540, paymentReceived: true });

    const r = res();
    await removeOffer(req({ lineKind: "main" }), r);
    expect(r.code).toBe(200);
    expect(m.booking).toMatchObject({ quotedPrice: 600, paymentReceived: false });
  });
});

describe("a once-per-phone offer used before", () => {
  beforeEach(() => {
    OFFER.oncePerPhone = true;
    m.usedOn = "ENQ-0153";
  });

  it("asks an Admin to confirm, naming the earlier booking", async () => {
    const r = res();
    await applyOffer(req({ offerId: "o1" }), r);
    expect(r.code).toBe(409);
    expect(r.body).toMatchObject({ code: "OFFER_REPEAT_CONFIRM", message: "launchman01 already used Diwali on ENQ-0153." });
    expect(m.synced).toEqual([]);
  });

  it("refuses Staff even when they ask to repeat", async () => {
    const r = res();
    await applyOffer(req({ offerId: "o1", repeat: true, note: "goodwill" }, "STAFF"), r);
    expect(r.code).toBe(400);
    expect(r.body.code).toBeUndefined();
    expect(m.synced).toEqual([]);
  });

  it("needs a reason to repeat", async () => {
    const r = res();
    await applyOffer(req({ offerId: "o1", repeat: true }), r);
    expect(r.code).toBe(400);
    expect(m.synced).toEqual([]);
  });

  it("applies it again for an Admin with a reason, and logs why", async () => {
    const r = res();
    await applyOffer(req({ offerId: "o1", repeat: true, note: "goodwill" }), r);
    expect(r.code).toBe(200);
    expect(m.synced).toEqual([540]);
    expect(m.booking.activityLog[0].action).toContain("again for this phone, first used on ENQ-0153. Reason: goodwill");
  });
});
