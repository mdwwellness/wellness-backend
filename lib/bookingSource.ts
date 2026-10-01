import { Doctor } from "../models/doctorsModel.ts";

/**
 * How a booking reached us. Drives the colour of the booking-ID pill in the
 * dashboard (online black, whatsapp green, walk-in blue, therapist orange).
 *
 * Deliberately NOT a schema enum on `source`: Mongoose validates every path on
 * `.save()`, and older rows still hold "dashboard" / "public_booking_form", so an
 * enum would make any save of an old document throw (e.g. the repeat-enquiry
 * fold in createBooking). This function is the one place the value is checked.
 */
export const BOOKING_SOURCES = ["online", "whatsapp", "walk_in", "therapist"] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];

export type ResolvedBookingSource =
  | { ok: false; code: 400; message: string }
  | {
      ok: true;
      fields: {
        source: BookingSource;
        referredByDoctorId: string | null;
        referredByName: string | null;
      };
    };

/**
 * Does this update genuinely change how the booking reached us?
 *
 * Most callers PUT the whole record back (Mark paid, autosave, the details
 * form), so the body usually just echoes the stored source. Two traps:
 *  - an older booking echoes "dashboard", which is no longer a valid value.
 *    Treating that as a change would 400 every save of an old booking.
 *  - a stale form can echo any old value.
 * So only a VALID source that differs counts, plus a changed referrer. Any
 * other value is an echo: ignored, never written, never an error.
 */
export function isSourceChange(
  body: { source?: unknown; referredByDoctorId?: unknown },
  stored: { source?: unknown; referredByDoctorId?: unknown },
): boolean {
  const validSource = BOOKING_SOURCES.includes(body.source as BookingSource);
  if (validSource && body.source !== stored.source) return true;
  return (
    "referredByDoctorId" in body &&
    (body.referredByDoctorId || null) !== (stored.referredByDoctorId || null)
  );
}

/**
 * Validate a source and, for therapist referrals, resolve the therapist.
 *
 * A missing source becomes "whatsapp", matching how the dashboard reads older
 * staff-entered bookings. That also keeps a dashboard that predates this field
 * working against this backend, rather than every booking bouncing with a 400.
 *
 * The referring therapist's name always comes from the Doctor record, never
 * from the client, so it can't be spoofed or drift from the roster.
 */
export async function resolveBookingSource(input: {
  source?: unknown;
  referredByDoctorId?: unknown;
}): Promise<ResolvedBookingSource> {
  const raw = input.source == null || input.source === "" ? "whatsapp" : input.source;

  if (!BOOKING_SOURCES.includes(raw as BookingSource)) {
    return {
      ok: false,
      code: 400,
      message: `Invalid booking source. Must be one of: ${BOOKING_SOURCES.join(", ")}.`,
    };
  }
  const source = raw as BookingSource;

  if (source !== "therapist") {
    return { ok: true, fields: { source, referredByDoctorId: null, referredByName: null } };
  }

  const doctorId = String(input.referredByDoctorId ?? "").trim();
  if (!doctorId) {
    return {
      ok: false,
      code: 400,
      message: "Pick the therapist who referred this booking.",
    };
  }

  const doctor = await Doctor.findOne({ doctorId }).select("name").lean();
  if (!doctor) {
    return { ok: false, code: 400, message: "That referring therapist doesn't exist." };
  }

  return {
    ok: true,
    fields: {
      source,
      referredByDoctorId: doctorId,
      referredByName: (doctor as { name?: string }).name ?? doctorId,
    },
  };
}
