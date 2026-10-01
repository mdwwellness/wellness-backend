import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindOne } = vi.hoisted(() => ({ mockFindOne: vi.fn() }));

vi.mock("../models/doctorsModel.ts", () => ({
  Doctor: { findOne: mockFindOne },
}));

import { isSourceChange, resolveBookingSource } from "./bookingSource.ts";

// Doctor.findOne(...).select(...).lean() resolving to `doc`.
function doctorLookupReturns(doc: unknown) {
  mockFindOne.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve(doc) }),
  });
}

describe("resolveBookingSource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts each plain source and clears the referral fields", async () => {
    for (const source of ["online", "whatsapp", "walk_in"]) {
      const r = await resolveBookingSource({ source, referredByDoctorId: "THR-0001" });
      expect(r).toEqual({
        ok: true,
        fields: { source, referredByDoctorId: null, referredByName: null },
      });
    }
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it("defaults a missing source to whatsapp, so an older dashboard still works", async () => {
    for (const source of [undefined, null, ""]) {
      const r = await resolveBookingSource({ source });
      expect(r.ok && r.fields.source).toBe("whatsapp");
    }
  });

  it("rejects legacy and unknown values instead of storing them", async () => {
    for (const source of ["dashboard", "public_booking_form", "instagram", 42]) {
      const r = await resolveBookingSource({ source });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(400);
    }
  });

  it("requires a therapist for a therapist referral", async () => {
    const r = await resolveBookingSource({ source: "therapist" });
    expect(r).toMatchObject({ ok: false, code: 400 });
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it("rejects a referring therapist that doesn't exist", async () => {
    doctorLookupReturns(null);
    const r = await resolveBookingSource({
      source: "therapist",
      referredByDoctorId: "THR-9999",
    });
    expect(r).toMatchObject({ ok: false, code: 400 });
  });

  it("takes the referrer's name from the roster, never from the client", async () => {
    doctorLookupReturns({ name: "Dr. Reddy" });
    const r = await resolveBookingSource({
      source: "therapist",
      referredByDoctorId: " THR-0007 ",
      // A client-sent name must play no part in the result.
      ...({ referredByName: "Someone Else" } as object),
    });
    expect(mockFindOne).toHaveBeenCalledWith({ doctorId: "THR-0007" });
    expect(r).toEqual({
      ok: true,
      fields: {
        source: "therapist",
        referredByDoctorId: "THR-0007",
        referredByName: "Dr. Reddy",
      },
    });
  });
});

describe("isSourceChange - whole-record PUTs echo the stored value", () => {
  it("ignores an echo of the stored source", () => {
    expect(isSourceChange({ source: "walk_in" }, { source: "walk_in" })).toBe(false);
  });

  it("ignores an echoed legacy value, so old bookings keep saving", () => {
    // The bug this guards: Mark paid on an old booking sends source "dashboard".
    expect(isSourceChange({ source: "dashboard" }, { source: "dashboard" })).toBe(false);
    expect(isSourceChange({ source: "dashboard" }, { source: "walk_in" })).toBe(false);
    expect(isSourceChange({ source: "public_booking_form" }, { source: undefined })).toBe(false);
  });

  it("ignores garbage rather than treating it as a change", () => {
    expect(isSourceChange({ source: "instagram" }, { source: "walk_in" })).toBe(false);
  });

  it("detects a real change to a valid source", () => {
    expect(isSourceChange({ source: "walk_in" }, { source: "dashboard" })).toBe(true);
    expect(isSourceChange({ source: "online" }, { source: "whatsapp" })).toBe(true);
  });

  it("detects a changed referrer", () => {
    expect(
      isSourceChange(
        { source: "therapist", referredByDoctorId: "THR-0002" },
        { source: "therapist", referredByDoctorId: "THR-0001" },
      ),
    ).toBe(true);
  });

  it("treats a missing and a null referrer as the same", () => {
    expect(
      isSourceChange({ source: "walk_in", referredByDoctorId: null }, { source: "walk_in" }),
    ).toBe(false);
  });
});
