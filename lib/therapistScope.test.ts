import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ findOne: vi.fn() }));
vi.mock("../models/appointmentsBookingModel.ts", () => ({ default: {} }));
vi.mock("../models/doctorsModel.ts", () => ({ Doctor: { findOne: m.findOne } }));

import { mayActOnBooking, mayActOnTherapist, ownDoctorId } from "./payments.ts";

const therapist = { role: "THERAPIST", _id: "u1", userEmail: "t@x.com" };

beforeEach(() => {
  m.findOne.mockReset();
  m.findOne.mockReturnValue({ lean: async () => ({ doctorId: "THR-1" }) });
});

describe("what a therapist may act on", () => {
  it("their own bookings and record only; the office acts on all", async () => {
    expect(await mayActOnBooking(therapist, { doctorId: "THR-1" })).toBe(true);
    expect(await mayActOnBooking(therapist, { doctorId: "THR-2" })).toBe(false);
    expect(await mayActOnBooking(therapist, {})).toBe(false);
    expect(await mayActOnTherapist(therapist, "THR-1")).toBe(true);
    expect(await mayActOnTherapist(therapist, "THR-2")).toBe(false);
    expect(await mayActOnBooking({ role: "ADMIN" }, { doctorId: "THR-2" })).toBe(true);
    expect(await mayActOnTherapist({ role: "STAFF" }, "THR-2")).toBe(true);
  });

  it("never matches every therapist for a login with no email", async () => {
    await ownDoctorId({ role: "THERAPIST", _id: "u1" });
    expect(m.findOne.mock.calls[0][0]).toEqual({ $or: [{ userId: "u1" }] });

    expect(await ownDoctorId({ role: "THERAPIST" })).toBeNull();
    expect(m.findOne).toHaveBeenCalledTimes(1);
  });
});
