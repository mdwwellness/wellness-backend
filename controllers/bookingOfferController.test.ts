import { describe, it, expect, vi, beforeEach } from "vitest";

// One unpaid ₹600 consultation and one fixed ₹60 offer.
const m = vi.hoisted(() => ({ booking: null as any, synced: [] as any[] }));

vi.mock("../models/appointmentsBookingModel.ts", () => ({
  default: {
    findById: () => ({ exec: async () => m.booking }),
    findOne: () => ({ select: () => ({ lean: async () => null }) }),
    findOneAndUpdate: (_q: any, update: any) => ({
      exec: async () => {
        m.booking = { ...m.booking, ...update.$set, appliedOffers: update.$push?.appliedOffers ? [update.$push.appliedOffers] : [] };
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
const req = (body: object) => ({ params: { bookingId: "b1" }, body, user: { role: "ADMIN", userfName: "Asha" } }) as any;

beforeEach(() => {
  m.booking = { _id: "b1", phonenumber: 9876500001, typeOfappointment: "consultation", quotedPrice: 600, paymentAmount: 0, appliedOffers: [], recommendedServices: [] };
  m.synced.length = 0;
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
