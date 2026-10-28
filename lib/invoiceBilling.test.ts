import { describe, it, expect, vi, beforeEach } from "vitest";

// One booking (a 4-session course) and its visits, plus the invoices on file.
const m = vi.hoisted(() => ({
  rows: {} as Record<string, any>,
  invoices: {} as Record<string, any>,
  created: [] as any[],
}));

vi.mock("../models/appointmentsBookingModel.ts", () => ({
  default: {
    findById: (id: string) => ({ exec: async () => m.rows[String(id)] ?? null }),
    find: (filter: any) => ({
      lean: async () => Object.values(m.rows).filter((r: any) => r.packageOriginId === filter.packageOriginId),
    }),
  },
}));
vi.mock("../models/invoiceModel.ts", () => ({
  default: {
    findOne: (q: any) => ({ exec: async () => m.invoices[String(q.appointment_id)] ?? null }),
    create: async (fields: any) => {
      m.created.push(fields);
      return fields;
    },
  },
}));
vi.mock("../models/serviceModel.ts", () => ({ default: { findOne: () => ({ exec: async () => null }) } }));
vi.mock("../models/customerModel.ts", () => ({
  default: {
    find: () => ({ exec: async () => [{ _id: "c1", customer_id: "CUST-1", name: "Asha", phone: 9876500001, email: "a@x.com", address: "x", gender: "female", birthYear: 1990 }] }),
    updateOne: async () => ({}),
  },
}));
vi.mock("./counters.ts", () => ({ nextSequence: async () => 1, nextYearlySequence: async () => 1 }));
vi.mock("./logger.ts", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { maybeCreateInvoiceForAppointment, syncInvoiceFromAppointment } from "./invoiceGeneration.ts";

// An open invoice on file: tracks what sync writes onto it.
function openInvoice(fields: object) {
  return { payment_status: "pending", locked_addon_items: [], ...fields, isModified: () => true, save: vi.fn() };
}

beforeEach(() => {
  m.created.length = 0;
  m.rows = {
    // Session 1 = the booking: ₹6,400 course, ₹3,200 paid.
    b1: { _id: "b1", enquiryId: "ENQ-1", name: "Asha", phonenumber: 9876500001, bookingKind: "course", quotedPrice: 6400, paymentAmount: 3200, status: "completed", totalSessions: 4, recommendedServices: [], slot: { date: new Date("2026-10-16T00:00:00Z"), time: "10:30" }, payments: [{ amount: 3200, method: "upi", at: new Date("2026-10-16T05:00:00Z") }] },
    // Session 2 of it, priced at its ₹1,600 share, now checked out.
    s2: {
      _id: "s2", enquiryId: "ENQ-2", name: "Asha", phonenumber: 9876500001, bookingKind: "course", quotedPrice: 1600, status: "completed", packageOriginId: "b1", sessionNumber: 2, slot: { date: new Date("2026-10-23T00:00:00Z"), time: "10:30" }, payments: [{ amount: 400, method: "cash", at: new Date("2026-10-23T05:30:00Z"), for: "Dry Needling" }],
      recommendedServices: [{ serviceId: "SRV-1", serviceName: "Dry Needling", quotedPrice: 400, status: "confirmed", recommendedAt: "t1", payments: [{ amount: 400 }], paidAmount: 400 }],
    },
    // An add-on visit of it.
    a1: { _id: "a1", enquiryId: "ENQ-3", name: "Asha", phonenumber: 9876500001, service: "Dry Needling", status: "completed", addonOf: { bookingId: "b1", key: "SRV-1|t1", session: 1 } },
  };
  m.invoices = { b1: openInvoice({ invoice_id: "INV-1", line_items: [{ description: "Therapy", price: 6400 }] }) };
});

describe("one invoice per booking", () => {
  it("checking out a course session updates the booking's invoice, not a new one", async () => {
    const inv: any = await syncInvoiceFromAppointment({ appointment: m.rows.s2 });

    expect(m.created).toHaveLength(0);
    expect(inv.invoice_id).toBe("INV-1");
    // The add-on recommended (and paid) during session 2 is on the booking's bill.
    expect(inv.line_items.map((l: any) => `${l.description} ${l.price}`)).toEqual(["Therapy 6400", "Add-on: Dry Needling 400"]);
    expect(inv).toMatchObject({ total: 6800, advance_paid: 3600, balance_due: 3200 });
    // Each line says when it's done and how much of it is paid.
    expect(inv.line_items).toMatchObject([
      { session: "16 Oct 2026 to 23 Oct 2026, 2 sessions", paid: 3200 },
      { session: "23 Oct 2026, same visit", paid: 400 },
    ]);
    // Payments from the booking and its sessions, oldest first.
    expect(inv.payments.map((p: any) => `${p.amount} ${p.method} ${p.for}`.trim())).toEqual(["3200 upi", "400 cash Dry Needling"]);
  });

  it("a course session or an add-on visit never gets its own invoice", async () => {
    m.invoices = {};
    expect(await maybeCreateInvoiceForAppointment({ appointment: m.rows.s2 })).toBeNull();
    expect(await maybeCreateInvoiceForAppointment({ appointment: m.rows.a1 })).toBeNull();
    expect(m.created).toHaveLength(0);
  });

  it("checking out an add-on visit updates the booking's invoice too", async () => {
    const inv: any = await syncInvoiceFromAppointment({ appointment: m.rows.a1 });
    expect(m.created).toHaveLength(0);
    expect(inv.invoice_id).toBe("INV-1");
  });
});

describe("consultation price (ISSUES #41)", () => {
  // Booked from the dashboard: no `service`, ₹600 less a ₹60 offer, paid.
  const consult = {
    _id: "c1", enquiryId: "ENQ-9", name: "Asha", phonenumber: 9876500001, typeOfappointment: "consultation", service: "",
    quotedPrice: 540, paymentAmount: 540, status: "scheduled", recommendedServices: [],
    slot: { date: new Date("2026-10-24T00:00:00Z"), time: "12:30" }, payments: [{ amount: 540, method: "upi", at: new Date("2026-10-24T05:00:00Z") }],
  };

  it("a dashboard-booked consultation is billed at its quote, not a flat ₹500", async () => {
    m.rows.c1 = consult;
    await maybeCreateInvoiceForAppointment({ appointment: consult });
    expect(m.created[0].line_items).toMatchObject([{ description: "Online Consultation", price: 540, paid: 540 }]);
    expect(m.created[0]).toMatchObject({ total: 540, advance_paid: 540, balance_due: 0 });
  });

  it("an open invoice billed at ₹500 is corrected to the quote on its next sync", async () => {
    m.rows.c1 = consult;
    m.invoices.c1 = openInvoice({ invoice_id: "INV-9", line_items: [{ description: "Online Consultation", price: 500 }] });
    const inv: any = await syncInvoiceFromAppointment({ appointment: consult });
    expect(inv).toMatchObject({ total: 540, advance_paid: 540, balance_due: 0, payment_status: "paid" });
  });
});

describe("a paid invoice still takes new charges (ISSUES #42)", () => {
  it("an add-on confirmed and paid after the invoice was paid is added to it", async () => {
    const booking = {
      _id: "h1", enquiryId: "ENQ-8", name: "Asha", phonenumber: 9876500001, typeOfappointment: "appointment", service: "Home Therapy",
      quotedPrice: 1600, paymentAmount: 1600, status: "completed", slot: { date: new Date("2026-10-26T00:00:00Z"), time: "13:00" },
      recommendedServices: [{ serviceId: "SRV-2", serviceName: "Acupuncture", quotedPrice: 500, status: "confirmed", recommendedAt: "t9", paidAmount: 500, paymentCollected: true }],
      payments: [{ amount: 1600, method: "upi", at: new Date("2026-10-26T08:15:00Z") }, { amount: 500, method: "upi", at: new Date("2026-10-26T08:21:00Z"), for: "Acupuncture" }],
    };
    m.rows.h1 = booking;
    m.invoices.h1 = openInvoice({ invoice_id: "INV-8", payment_status: "paid", total: 1600, advance_paid: 1600, line_items: [{ description: "Home Visit Consultation", price: 1600 }] });

    const inv: any = await syncInvoiceFromAppointment({ appointment: booking });

    expect(inv.line_items.map((l: any) => `${l.description} ${l.price}`)).toEqual(["Home Visit Consultation 1600", "Add-on: Acupuncture 500"]);
    expect(inv).toMatchObject({ total: 2100, advance_paid: 2100, balance_due: 0, payment_status: "paid" });
  });
});
