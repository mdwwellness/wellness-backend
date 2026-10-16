import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindOne } = vi.hoisted(() => ({ mockFindOne: vi.fn() }));
vi.mock("../models/serviceModel.ts", () => ({ default: { findOne: mockFindOne } }));
vi.mock("./invoiceGeneration.ts", () => ({
  BOOKING_TYPE_SERVICE: { consultation: "Online Consultation", appointment: "Home Visit Consultation" },
}));

import { applyLockedFields } from "./lockedFields.ts";

const prices: Record<string, number> = { "online consultation": 600, "home visit consultation": 1600 };

beforeEach(() => {
  mockFindOne.mockImplementation(({ name }: { name: RegExp }) => ({
    lean: () => Promise.resolve(
      Object.entries(prices).find(([n]) => name.test(n)) ? { originalPrice: Object.entries(prices).find(([n]) => name.test(n))![1] } : null,
    ),
  }));
});

const intake = { bookingKind: "intake", name: "Asha", phonenumber: 9876500001, email: "", typeOfappointment: "consultation", quotedPrice: 600 };

describe("applyLockedFields", () => {
  it("keeps stored customer details, but lets a blank email be filled", async () => {
    const u: any = { name: "Hacked", phonenumber: 9000000000, email: "a@b.com" };
    await applyLockedFields(u, intake);
    expect(u).toEqual({ email: "a@b.com" });
  });

  it("a therapist changes none of the customer's details, not even a blank", async () => {
    const u: any = { name: "X", phonenumber: 9000000000, email: "a@b.com", location: "Y", age: 40, gender: "male", note: "kept" };
    await applyLockedFields(u, intake, "THERAPIST");
    expect(u).toEqual({ note: "kept" });
  });

  it("a therapist can't move or reassign a visit, only the office can", async () => {
    const u: any = { doctorId: "THR-9", doctor: "Me", slot: { date: "2026-10-20", time: "9:30" }, therapyStartTime: "9:30", therapyEndTime: "10:30", workChecklist: ["arrived"] };
    await applyLockedFields(u, intake, "THERAPIST");
    expect(u).toEqual({ workChecklist: ["arrived"] });
  });

  it("a therapist can't cancel a booking, but can still start it", async () => {
    const cancel: any = { status: "cancelled" };
    await applyLockedFields(cancel, { ...intake, status: "scheduled" }, "THERAPIST");
    expect(cancel).toEqual({});

    const start: any = { status: "ongoing" };
    await applyLockedFields(start, { ...intake, status: "scheduled" }, "THERAPIST");
    expect(start).toEqual({ status: "ongoing" });

    const office: any = { status: "cancelled" };
    await applyLockedFields(office, { ...intake, status: "scheduled" }, "ADMIN");
    expect(office).toEqual({ status: "cancelled" });
  });

  it("a course keeps the price and length it was booked with", async () => {
    const u: any = { quotedPrice: 1, originalPrice: 2, totalSessions: 99, note: "kept" };
    await applyLockedFields(u, { ...intake, bookingKind: "course", quotedPrice: 6400, totalSessions: 4 }, "ADMIN");
    expect(u).toEqual({ note: "kept" });
  });

  it("ignores a typed fee on an intake", async () => {
    const u: any = { quotedPrice: 1 };
    await applyLockedFields(u, intake);
    expect(u).toEqual({});
  });

  it("re-prices from the catalogue when the type changes", async () => {
    const u: any = { typeOfappointment: "appointment", quotedPrice: 5 };
    await applyLockedFields(u, intake);
    expect(u.quotedPrice).toBe(1600);
  });

  it("keeps the price once any money is in, even if the type changes", async () => {
    const u: any = { typeOfappointment: "appointment" };
    await applyLockedFields(u, { ...intake, paymentAmount: 200 });
    expect(u.quotedPrice).toBeUndefined();
  });

});
