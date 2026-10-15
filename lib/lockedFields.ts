import Service from "../models/serviceModel.ts";
import { BOOKING_TYPE_SERVICE } from "./invoiceGeneration.ts";

// Who the booking is for. Set when the booking is created; after that a
// client update may only fill a blank, never change a stored value.
const CUSTOMER_FIELDS = ["name", "phonenumber", "email"] as const;

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
 * Mutates `update` (the PUT body) in place; `cur` is the stored booking.
 *
 * ponytail: intakes only. Course prices still come from the client (rate-table
 * tiers live in the frontend); move that pricing here to lock courses too.
 */
export async function applyLockedFields(update: any, cur: any): Promise<void> {
  for (const f of CUSTOMER_FIELDS) {
    if (!blank(cur[f])) delete update[f];
  }

  if (!isIntake(cur)) return;

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
