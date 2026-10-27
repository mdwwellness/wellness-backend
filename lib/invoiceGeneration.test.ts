import { describe, it, expect, vi, beforeEach } from "vitest";

// A Customer model whose reads and writes take a real tick, so concurrent
// callers interleave the way they do against MongoDB.
const m = vi.hoisted(() => ({
  stored: [] as any[],
  failNextFind: false,
  seq: 0,
}));
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

vi.mock("../models/customerModel.ts", () => ({
  default: class FakeCustomer {
    static find(filter: { phone: number }) {
      return {
        exec: async () => {
          await tick();
          if (m.failNextFind) {
            m.failNextFind = false;
            throw new Error("connection lost");
          }
          return m.stored.filter((c) => c.phone === filter.phone);
        },
      };
    }
    static async updateOne(filter: { _id: unknown }, update: { $set: object }) {
      Object.assign(m.stored.find((c) => c._id === filter._id), update.$set);
    }
    _id = Symbol("id");
    constructor(fields: object) {
      Object.assign(this, fields);
    }
    async save() {
      await tick();
      m.stored.push(this);
    }
  },
}));
vi.mock("./counters.ts", () => ({
  nextSequence: async () => ++m.seq,
  nextYearlySequence: async () => ++m.seq,
}));
vi.mock("./invoicePdf.ts", () => ({ ensureInvoicePdfGeneratedAndUploaded: vi.fn() }));
vi.mock("./logger.ts", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { ensureCustomerForAppointment } from "./invoiceGeneration.ts";
import { todayInIndia } from "./personDetails.ts";

const ASHA = { phonenumber: 9876543210, name: "Asha Verma" };

beforeEach(() => {
  m.stored.length = 0;
  m.failNextFind = false;
  m.seq = 0;
});

describe("ensureCustomerForAppointment", () => {
  it("creates exactly one customer for concurrent calls with the same phone and name", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        ensureCustomerForAppointment({ ...ASHA, name: i % 2 ? "asha verma " : "Asha Verma" }),
      ),
    );

    expect(m.stored).toHaveLength(1);
    expect(new Set(results.map((c) => c.customer_id))).toEqual(new Set(["CUST-0001"]));
  });

  it("still gives a different name on the same phone its own record", async () => {
    await Promise.all([
      ensureCustomerForAppointment(ASHA),
      ensureCustomerForAppointment({ ...ASHA, name: "Ravi Verma" }),
      ensureCustomerForAppointment(ASHA),
    ]);
    expect(m.stored.map((c) => c.name).sort()).toEqual(["Asha Verma", "Ravi Verma"]);
  });

  it("a failed call does not block the next one for that phone", async () => {
    m.failNextFind = true;
    const [failed, other] = await Promise.allSettled([
      ensureCustomerForAppointment(ASHA),
      ensureCustomerForAppointment({ phonenumber: 9123456789, name: "Meera Das" }),
    ]);
    expect(failed.status).toBe("rejected");
    expect(other.status).toBe("fulfilled");

    await expect(ensureCustomerForAppointment(ASHA)).resolves.toMatchObject({ name: "Asha Verma" });
  });

  it("a same-phone call queued behind a failing one still succeeds", async () => {
    m.failNextFind = true;
    const [first, second] = await Promise.allSettled([
      ensureCustomerForAppointment(ASHA),
      ensureCustomerForAppointment(ASHA),
    ]);
    expect(first.status).toBe("rejected");
    expect(second).toMatchObject({ status: "fulfilled", value: { name: "Asha Verma" } });
    expect(m.stored).toHaveLength(1);
  });

  it("a booking fills the customer's missing details but never overwrites them", async () => {
    const at = "2026-10-16T05:00:00Z";
    await ensureCustomerForAppointment({ ...ASHA, gender: "female", age: 30, createdAt: at });
    await ensureCustomerForAppointment({ ...ASHA, gender: "male", age: 50, email: "a@x.com", createdAt: at });

    expect(m.stored).toHaveLength(1);
    expect(m.stored[0]).toMatchObject({ gender: "female", birthYear: 1996, email: "a@x.com" });
  });

  it("a new booking for a known customer takes their gender and age", async () => {
    await ensureCustomerForAppointment({ ...ASHA, gender: "female", age: 30, createdAt: "2026-10-16T05:00:00Z" });
    const booking: any = { ...ASHA, save: vi.fn() };

    await ensureCustomerForAppointment(booking);

    expect(booking).toMatchObject({
      customer_id: "CUST-0001",
      gender: "female",
      age: Number(todayInIndia().slice(0, 4)) - 1996,
    });
    expect(booking.save).toHaveBeenCalled();
  });

  it("a new booking also takes the customer's email and address, but never overwrites typed ones", async () => {
    await ensureCustomerForAppointment({ ...ASHA, email: "asha@x.com", location: "12 Lake Rd" });
    const blank: any = { ...ASHA, save: vi.fn() };
    const typed: any = { ...ASHA, email: "new@x.com", location: "Office", save: vi.fn() };

    await ensureCustomerForAppointment(blank);
    await ensureCustomerForAppointment(typed);

    expect(blank).toMatchObject({ email: "asha@x.com", location: "12 Lake Rd" });
    expect(typed).toMatchObject({ email: "new@x.com", location: "Office" });
  });
});
