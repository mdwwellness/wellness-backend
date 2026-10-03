import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { payableLedger } from "./bookingMoney.ts";
import { createBooking } from "./bookingService.ts";
import { OFFERINGS } from "./offerings.ts";
import { isPlainObject } from "./validation.ts";

export type CustomerBooking = {
  enquiryId: string | null;
  patientName: string;
  service: string | null;
  typeOfappointment: string | null;
  bookingKind: string | null;
  status: string;
  slot: { date: string | null; time: string | null } | null;
  therapistName: string | null;
  sessionsCompleted: number;
  totalSessions: number | null;
  preferredReachOutTime: { from: string; to: string } | null;
  amountDue: number | null;
  paymentReceived: boolean;
  payToken: string | null;
  createdAt: string | null;
};

// Only what toCustomerBooking and payableLedger read, so internal fields
// (notes, address, OTP hashes, staff trail) never even leave the database.
const BOOKING_FIELDS =
  "enquiryId name service typeOfappointment bookingKind status slot physioSlot doctor " +
  "sessionsCompleted totalSessions preferredReachOutTime quotedPrice " +
  "paymentReceived recommendedServices packageOriginId payToken createdAt";

// slot.date is a Date at UTC midnight and physioSlot.date a "YYYY-MM-DD"
// string, which also parses as UTC midnight, so the UTC day is the booked day.
function toIsoDay(value: unknown): string | null {
  if (!value) return null;
  const d = new Date(value as string | Date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** A booking as the customer may see it: explicit allow-list, nothing internal. */
export function toCustomerBooking(doc: any): CustomerBooking {
  // Staff write physioSlot when they schedule the visit; slot is what was asked
  // for. Same fallback as the dashboard's calendar and conflict checks.
  const date = toIsoDay(doc.physioSlot?.date || doc.slot?.date);
  const time = doc.physioSlot?.time || doc.slot?.time || null;
  const window = doc.preferredReachOutTime;
  const cancelled = doc.status === "cancelled";
  // null = nothing payable on this row: cancelled, not priced yet, or a course
  // follow-up with no add-ons (payableLedger drops its per-session share).
  // Without the "nothing priced" case a fresh enquiry read as paid.
  const ledger = payableLedger(doc);
  const amountDue = cancelled || ledger.lines.length === 0 ? null : ledger.due;
  return {
    enquiryId: doc.enquiryId ?? null,
    patientName: doc.name ?? "",
    service: doc.service ?? null,
    typeOfappointment: doc.typeOfappointment ?? null,
    bookingKind: doc.bookingKind ?? null,
    status: doc.status ?? "enquiry",
    slot: date || time ? { date, time } : null,
    therapistName: doc.doctor || null,
    sessionsCompleted: doc.sessionsCompleted ?? 0,
    totalSessions: doc.totalSessions ?? null,
    preferredReachOutTime:
      window?.from && window?.to ? { from: window.from, to: window.to } : null,
    amountDue,
    // Same rule as the public pay page: settled once nothing is due.
    paymentReceived: amountDue !== null ? amountDue <= 0 : doc.paymentReceived === true,
    payToken: cancelled ? null : doc.payToken ?? null,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
  };
}

// ponytail: newest 100, no pagination; add a cursor when a phone really has more.
export async function listBookingsForPhone(phone10: string): Promise<CustomerBooking[]> {
  const docs = await AppointmentBooking.find({ phonenumber: Number(phone10) })
    .select(BOOKING_FIELDS)
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  return docs.map((doc) => toCustomerBooking(doc));
}

export type BookingRequest = {
  service: (typeof OFFERINGS)[number];
  preferredReachOutTime?: { from: string; to: string };
  note?: string;
  vitals?: string[];
  location?: string;
};

// Everything else (price, payment, therapist, status, source...) is staff-only.
const BOOKING_REQUEST_KEYS = ["service", "preferredReachOutTime", "note", "vitals", "location"];

const isHHMM = (v: unknown): v is string =>
  typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

type Invalid = { ok: false; message: string };
const invalid = (message: string): Invalid => ({ ok: false, message });

/** Strict allow-list for POST /bookings. null or blank optional fields mean "not given". */
export function validateBookingRequest(
  body: unknown,
): { ok: true; value: BookingRequest } | Invalid {
  if (!isPlainObject(body)) return invalid("Invalid request body.");
  const b = body as Record<string, any>;

  const unknownKeys = Object.keys(b).filter((k) => !BOOKING_REQUEST_KEYS.includes(k));
  if (unknownKeys.length) return invalid(`Unknown field(s): ${unknownKeys.join(", ")}.`);

  // The app books exactly what the patient site sells.
  if (!(OFFERINGS as readonly unknown[]).includes(b.service)) {
    return invalid(`Service must be one of: ${OFFERINGS.join(", ")}.`);
  }
  const value: BookingRequest = { service: b.service };

  const time = b.preferredReachOutTime;
  if (time != null) {
    if (typeof time !== "object" || !isHHMM(time.from) || !isHHMM(time.to) || time.from >= time.to) {
      return invalid("Preferred time must be { from, to } in 24-hour HH:MM, with from before to.");
    }
    value.preferredReachOutTime = { from: time.from, to: time.to };
  }

  if (b.note != null) {
    if (typeof b.note !== "string" || b.note.trim().length > 1000) {
      return invalid("Note must be text of at most 1000 characters.");
    }
    if (b.note.trim()) value.note = b.note.trim();
  }

  if (b.location != null) {
    if (typeof b.location !== "string" || b.location.trim().length > 300) {
      return invalid("Location must be text of at most 300 characters.");
    }
    if (b.location.trim()) value.location = b.location.trim();
  }

  const vitals = b.vitals;
  if (vitals != null) {
    const valid =
      Array.isArray(vitals) &&
      vitals.length <= 10 &&
      vitals.every((v) => typeof v === "string" && v.trim() && v.trim().length <= 100);
    if (!valid) return invalid("Vitals must be a list of up to 10 items, each at most 100 characters.");
    if (vitals.length && value.service !== "Vitals Check") {
      return invalid("Vitals can only be sent with the Vitals Check service.");
    }
    if (vitals.length) value.vitals = vitals.map((v: string) => v.trim());
  }

  return { ok: true, value };
}

/**
 * Creates (or folds into an open) enquiry for a signed-in customer. Who it is
 * for comes from the verified account, never from the request body.
 */
export async function createBookingForCustomer(
  who: { phone10: string; name: string; email?: string; defaultLocation?: string },
  request: BookingRequest,
): Promise<{ ok: true; enquiryId: string; folded: boolean } | { ok: false; status: number; message: string }> {
  // Field by field on purpose: createBooking spreads its input into the new
  // document, so anything passed through here would be stored as-is.
  const result = await createBooking(
    {
      name: who.name,
      phonenumber: Number(who.phone10),
      email: who.email || undefined,
      location: request.location || who.defaultLocation || undefined,
      // Same mapping as the patient site: only the online consultation is remote.
      typeOfappointment: request.service === "Online Consultation" ? "consultation" : "appointment",
      service: request.service,
      vitals: request.vitals,
      preferredReachOutTime: request.preferredReachOutTime,
      note: request.note,
      status: "enquiry",
    },
    { source: "online", foldOpenRepeats: true },
  );
  if (!result.ok) return { ok: false, status: result.code, message: result.message };
  return { ok: true, enquiryId: result.appointment.enquiryId, folded: result.folded };
}
