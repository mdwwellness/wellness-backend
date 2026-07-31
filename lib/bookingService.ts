import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { nextSequence } from "./counters.ts";
import { logger } from "./logger.ts";
import {
  ensureCustomerForAppointment,
  maybeCreateInvoiceForAppointment,
} from "./invoiceGeneration.ts";

// Statuses considered "open" for repeat-submission folding.
const OPEN_STATUSES = ["enquiry", "scheduled", "ongoing"];

export interface CreateBookingActor {
  name?: string;
  email?: string;
}

export interface CreateBookingOptions {
  /** Where the booking came from (e.g. "dashboard", "public_booking_form"). */
  source?: string;
  /** Who triggered it (back-office user), for invoice attribution. */
  actor?: CreateBookingActor;
  /**
   * When true, a new submission for a phone that already has an OPEN lead is
   * folded into that lead (repeatCount bumped, activity logged) instead of
   * creating a duplicate row. Public form uses this; dashboard can opt in.
   */
  foldOpenRepeats?: boolean;
}

export type CreateBookingResult =
  | { ok: false; code: number; message: string }
  | { ok: true; folded: true; appointment: any; repeatCount: number }
  | { ok: true; folded: false; appointment: any };

/**
 * THE single sanctioned way to create a booking / enquiry. Every entry point
 * (dashboard, public patient site, enquiry conversion, and any future door)
 * funnels through here, so the side-effects - validation guards, ID
 * allocation, customer linkage, invoice generation - stay identical no matter
 * who calls it. Add a new step here once and every caller inherits it.
 *
 * Guards are self-gating: they only fire when the relevant fields are present,
 * so a bare enquiry (no slot/therapist) passes straight through.
 */
export async function createBooking(
  input: Record<string, any>,
  opts: CreateBookingOptions = {},
): Promise<CreateBookingResult> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const phonenumber = input.phonenumber;

  if (!name || name.length < 2) {
    return {
      ok: false,
      code: 400,
      message: "Name is required (at least 2 characters).",
    };
  }
  if (!phonenumber || typeof phonenumber !== "number") {
    return {
      ok: false,
      code: 400,
      message: "Phone number is required (numeric).",
    };
  }

  // Past-date guard - only when a slot date is given.
  if (input.slot?.date) {
    const slotDate = new Date(input.slot.date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (!Number.isNaN(slotDate.getTime()) && slotDate < today) {
      return { ok: false, code: 400, message: "Cannot book a slot in the past." };
    }
  }

  // Double-booking guard - only when therapist + full slot are given.
  if (input.doctorId && input.slot?.date && input.slot?.time) {
    const clash = await AppointmentBooking.findOne({
      doctorId: input.doctorId,
      "slot.date": input.slot.date,
      "slot.time": input.slot.time,
      status: { $ne: "cancelled" },
    }).exec();
    if (clash) {
      return {
        ok: false,
        code: 409,
        message: "That therapist is already booked at this date and time.",
      };
    }
  }

  // Pay-first: never assign a therapist before payment is cleared. Self-gating -
  // only fires when a therapist is on the payload, so a bare enquiry passes.
  // Mirrors the guard in updateAppointment; kept here so EVERY create path
  // (dashboard modal, public form, conversion) inherits it and none can skip it.
  if (input.doctorId && input.paymentReceived !== true) {
    return {
      ok: false,
      code: 400,
      message: "Record the payment before assigning a therapist.",
    };
  }

  // An unpriced booking generates NO invoice at all, so it would silently never
  // bill. Self-gating the same way: only fires once a therapist is on the
  // payload, so a bare public enquiry (price legitimately unknown) still passes.
  if (input.doctorId && !(Number(input.quotedPrice) > 0)) {
    return {
      ok: false,
      code: 400,
      message: "Set the booking price before assigning a therapist.",
    };
  }

  // Repeat folding for open leads (opt-in).
  if (opts.foldOpenRepeats) {
    // Fold only a TRUE repeat: same phone AND same person. A different name on
    // the same (often shared / household) number is a different patient, so
    // they get their own lead instead of being folded into - and hidden behind
    // - someone else's. Names compare case/space-insensitively, so re-typing the
    // same name slightly differently still folds.
    const target = name.trim().toLowerCase();
    const openLeads = await AppointmentBooking.find({
      phonenumber,
      status: { $in: OPEN_STATUSES },
    });
    const existing = openLeads.find(
      (lead) => (lead.name ?? "").trim().toLowerCase() === target,
    );
    if (existing) {
      const repeatCount = (existing.repeatCount ?? 1) + 1;

      const detailBits: string[] = [];
      if (input.typeOfappointment)
        detailBits.push(`type: ${input.typeOfappointment}`);
      if (input.location) detailBits.push(`location: ${input.location}`);
      if (input.preferredReachOutTime?.from || input.preferredReachOutTime?.to) {
        detailBits.push(
          `time: ${input.preferredReachOutTime?.from ?? "?"}-${input.preferredReachOutTime?.to ?? "?"}`,
        );
      }
      if (input.note) detailBits.push(`note: ${input.note}`);
      const action = `Re-submitted (#${repeatCount})${
        detailBits.length ? ": " + detailBits.join(", ") : ""
      }`;

      existing.repeatCount = repeatCount;
      existing.activityLog.push({
        at: new Date().toISOString(),
        name,
        action,
      });
      await existing.save();
      logger.info("Booking repeat folded into existing lead", {
        enquiryId: existing.enquiryId,
        repeatCount,
      });
      return { ok: true, folded: true, appointment: existing, repeatCount };
    }
  }

  // Allocate the booking / enquiry ID and persist.
  const seq = await nextSequence("enquiry");
  const enquiryId = `ENQ-${String(seq).padStart(4, "0")}`;

  const appointment = new AppointmentBooking({
    ...input,
    name,
    enquiryId,
    status: input.status || "enquiry",
    source: input.source || opts.source || undefined,
  });
  await appointment.save();
  logger.info("Booking created", {
    enquiryId,
    source: input.source || opts.source,
    phonenumber,
  });

  // Side-effects - identical for EVERY caller now.
  await ensureCustomerForAppointment(appointment);
  await maybeCreateInvoiceForAppointment({ appointment, actor: opts.actor });

  return { ok: true, folded: false, appointment };
}
