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

  it("ignores a typed fee and payment amount on an intake", async () => {
    const u: any = { quotedPrice: 1, paymentAmount: 60034 };
    await applyLockedFields(u, intake);
    expect(u).toEqual({});
  });

  it("re-prices from the catalogue when the type changes", async () => {
    const u: any = { typeOfappointment: "appointment", quotedPrice: 5 };
    await applyLockedFields(u, intake);
    expect(u.quotedPrice).toBe(1600);
  });

  it("records the price as the amount paid", async () => {
    const u: any = { paymentReceived: true, paymentAmount: 60034 };
    await applyLockedFields(u, intake);
    expect(u.paymentAmount).toBe(600);
  });

  it("refuses payment on an unpriced intake", async () => {
    mockFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    await expect(
      applyLockedFields({ paymentReceived: true }, { ...intake, quotedPrice: undefined }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("leaves course prices alone", async () => {
    const u: any = { quotedPrice: 9000 };
    await applyLockedFields(u, { ...intake, bookingKind: "course", totalSessions: 6 });
    expect(u.quotedPrice).toBe(9000);
  });
});
