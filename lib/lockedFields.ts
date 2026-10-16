import Service from "../models/serviceModel.ts";
import { BOOKING_TYPE_SERVICE } from "./invoiceGeneration.ts";

// Who the booking is for. Set when the booking is created; after that a
// client update may only fill a blank, never change a stored value.
const CUSTOMER_FIELDS = ["name", "phonenumber", "email"] as const;
// A therapist changes none of the customer's details, not even a blank, and
// doesn't move or reassign a visit: only the office does (client rule).
const THERAPIST_LOCKED = [
  ...CUSTOMER_FIELDS, "location", "age", "gender",
  "doctorId", "doctor", "slot", "physioSlot", "therapyStartTime", "therapyEndTime",
] as const;

const blank = (v: unknown) => v === undefined || v === null || v === "";

/** An intake (online consultation / home visit), not a course or a course follow-up row. */
export function isIntake(cur: any): boolean {
  if (cur.bookingKind) return cur.bookingKind === "intake";
  return !((cur.totalSessions ?? 0) >= 1) && !cur.packageOriginId;
}

/** Catalogue price for a booking type, or undefined when it isn't on the Services page. */
export async function cataloguePrice(type: string | undefined): Promise<number | undefined> {
  const name = type ? BOOKING_TYPE_SERVICE[type] : undefined;
  if (!name) return undefined;
  const svc: any = await Service.findOne({ name: new RegExp(`^${name}$`, "i") }).lean();
  return svc?.originalPrice ?? undefined;
}

/**
 * Strips what a dashboard user must not be able to change on an existing
 * booking, and sets the intake price from the catalogue instead of the client.
 * Mutates `update` (the PUT body) in place; `cur` is the stored booking and
 * `role` the signed-in user's.
 *
 * A course's price is locked once booked. ponytail: it's still worked out by
 * the booking form when the course is created (rate-table tiers live in the
 * frontend); move that pricing here to check it at creation too.
 */
export async function applyLockedFields(update: any, cur: any, role?: string): Promise<void> {
  for (const f of CUSTOMER_FIELDS) {
    if (!blank(cur[f])) delete update[f];
  }
  if (role === "THERAPIST") for (const f of THERAPIST_LOCKED) delete update[f];
  // Only the office cancels a booking (client rule). An echoed "cancelled" on an
  // already-cancelled booking is no change, so it passes.
  if (role === "THERAPIST" && update.status === "cancelled" && cur.status !== "cancelled") delete update.status;

  if (!isIntake(cur)) {
    // A course's price and length are set when it's booked (from the session
    // rate table); a client update never changes them. Changing a course
    // properly means adding or removing its visits, which a field edit can't do.
    delete update.quotedPrice;
    delete update.originalPrice;
    delete update.totalSessions;
    return;
  }

  // The price is never taken from the client. Once any money is in, the booking
  // keeps the price it was paid against; before that it's (re)priced when its
  // type changes or it has no price yet, so a later catalogue change never
  // rewrites old bookings. (Payments themselves go through lib/payments.ts.)
  delete update.quotedPrice;
  delete update.originalPrice;

  const type = update.typeOfappointment ?? cur.typeOfappointment;
  const typeChanged = update.typeOfappointment !== undefined && update.typeOfappointment !== cur.typeOfappointment;
  if (!(Number(cur.paymentAmount) > 0) && (typeChanged || !(Number(cur.quotedPrice) > 0))) {
    const price = await cataloguePrice(type);
    if (price !== undefined) update.quotedPrice = price;
  }
}
