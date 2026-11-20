import { describe, expect, it } from "vitest";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { asListRow } from "./listRows.ts";

const at = new Date("2026-11-20T10:00:00Z");
const input: any = {
  enquiryId: "ENQ-1", name: "N", phonenumber: 9000000001, status: "scheduled", doctorId: "THR-0004",
  slot: { date: at, time: "10:00" }, vitals: ["BP"], workChecklist: ["x"],
  customerNotes: [{ note: "c" }], activityLog: [{ action: "created" }], payments: [{ amount: 800 }],
  therapistPayouts: [{ doctorId: "THR-0004", amount: 100 }], sessionNotes: [{ doctorId: "THR-0004", note: "n" }],
  recommendedServices: [{ serviceId: "s1" }], appliedOffers: [{ offerId: "o1" }],
};
const stored: any = new AppointmentBooking(input).toObject();

/** The record as an older version saved it: only what was given, no defaults (top level or nested). */
function oldRecord() {
  const old: any = { _id: stored._id };
  for (const k of Object.keys(input)) {
    const v = stored[k];
    old[k] = Array.isArray(v) && typeof v[0] === "object"
      ? v.map((it: any, i: number) => Object.fromEntries(Object.entries(it).filter(([f]) => f === "_id" || f in input[k][i])))
      : Array.isArray(v) ? [...v] : v?.constructor === Object ? { ...v } : v;
  }
  return old;
}
const json = (x: unknown) => JSON.parse(JSON.stringify(x));

describe("asListRow: a lean booking reads exactly like the Mongoose document did", () => {
  it.each([
    ["an older record missing newer fields, nested ones too", oldRecord],
    ["a bare record", () => ({ _id: stored._id, name: "old" })],
    ["a full record", () => ({ ...stored })],
  ])("%s", (_label, make) => {
    expect(json(asListRow(make()))).toEqual(json(AppointmentBooking.hydrate(make()).toObject()));
  });

  it("does not invent empty slots or add-on links (truthy {} would change what the screens show)", () => {
    const row = asListRow({ _id: stored._id, name: "old" });
    expect(row).not.toHaveProperty("slot");
    expect(row).not.toHaveProperty("addonOf");
    expect(row.payments).toEqual([]);
  });
});
