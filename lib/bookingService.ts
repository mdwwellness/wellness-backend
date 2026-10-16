import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import ClinicSettings from "../models/clinicSettingsModel.ts";
import { nextSequence } from "./counters.ts";
import { logger } from "./logger.ts";
import { resolveBookingSource } from "./bookingSource.ts";
import { cataloguePrice, isIntake } from "./lockedFields.ts";
import {
  ensureCustomerForAppointment,
  maybeCreateInvoiceForAppointment,
} from "./invoiceGeneration.ts";

export interface CreateBookingActor {
  name?: string;
  email?: string;
}

export interface CreateBookingOptions {
  /**
   * Pins the booking source for an entry point that can only mean one thing
   * (the public site is always "online"). Leave unset to take the client's pick.
   */
  source?: string;
  /** Who triggered it (back-office user), for invoice attribution. */
  actor?: CreateBookingActor;
  /**
   * When true, a re-submission of the same request (same phone, name and
   * service) while its lead is still an un-actioned "enquiry" is folded into
   * that lead (repeatCount bumped, activity logged) instead of creating a
   * duplicate row. Public form and Customers' App use this; dashboard can opt in.
   */
  foldOpenRepeats?: boolean;
}

export type CreateBookingResult =
  | { ok: false; code: number; message: string }
  | { ok: true; folded: true; appointment: any; repeatCount: number }
  | { ok: true; folded: false; appointment: any };

// A visit with no stored end time is taken to last this long.
const DEFAULT_VISIT_MIN = 60;

/** "9:30" or "09:30" → minutes from midnight; anything else → NaN. */
function toMinutes(t: unknown): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/**
 * Why this therapist can't take [start, end) on `date`, or null when they can.
 * Overlapping another visit, or leaving less than the clinic's booking gap
 * before or after one, are both refused (client rule): only cancelling that
 * visit frees the time. Reads like "is already booked at 14:30", for callers to
 * put after the therapist's name. Shared by every path that books a
 * therapist's time (createBooking, add-on visits, moving a visit) so the rule
 * lives in one place. Mirrors checkConflict in the dashboard.
 */
export async function findTherapistClash(args: {
  doctorId: string;
  date: string | Date;
  start: string;
  end?: string;
  excludeId?: unknown;
}): Promise<string | null> {
  const startMin = toMinutes(args.start);
  if (Number.isNaN(startMin)) return null;
  const endRaw = toMinutes(args.end);
  const endMin = endRaw > startMin ? endRaw : startMin + DEFAULT_VISIT_MIN;

  const [visits, settings] = await Promise.all([
    AppointmentBooking.find(
      {
        doctorId: args.doctorId,
        "slot.date": args.date,
        status: { $ne: "cancelled" },
        ...(args.excludeId ? { _id: { $ne: args.excludeId } } : {}),
      },
      { slot: 1, physioSlot: 1, therapyStartTime: 1, therapyEndTime: 1 },
    ).lean(),
    ClinicSettings.findOne({ key: "global" }, { bookingGapMinutes: 1 }).lean(),
  ]);
  const gap = (settings as any)?.bookingGapMinutes ?? 60;

  for (const v of visits as any[]) {
    const time = v.therapyStartTime || v.physioSlot?.time || v.slot?.time;
    const vStart = toMinutes(time);
    if (Number.isNaN(vStart)) continue;
    const vEndRaw = toMinutes(v.therapyEndTime);
    const vEnd = vEndRaw > vStart ? vEndRaw : vStart + DEFAULT_VISIT_MIN;
    if (startMin < vEnd && vStart < endMin) return `is already booked at ${time}`;
    const between = endMin <= vStart ? vStart - endMin : startMin - vEnd;
    if (between < gap) return `needs ${gap} min between visits and has one at ${time}`;
  }
  return null;
}

/** How a course's sessions repeat: so many a week (1-4), or every N days (older courses). */
export type CourseSchedule = { perWeek: number; intervalDays: number };

/** A course's schedule from a booking, or null when it has no repeat. */
export function courseScheduleOf(b: any): CourseSchedule | null {
  const perWeek = Number(b?.sessionsPerWeek);
  const intervalDays = Number(b?.sessionIntervalDays) || 0;
  const s = { perWeek: Number.isInteger(perWeek) && perWeek >= 1 && perWeek <= 4 ? perWeek : 0, intervalDays };
  return s.perWeek || s.intervalDays > 0 ? s : null;
}

/**
 * Days from session 1 to session `n` (1-based). So many a week spreads them
 * evenly through each week: twice a week from a Tuesday is Tue, Fri, Tue, Fri;
 * three times from a Monday is Mon, Wed, Fri. Mirrors the dashboard's
 * src/lib/course-schedule.ts - KEEP IN SYNC.
 */
export function courseDayOffset(n: number, s: CourseSchedule): number {
  const k = n - 1;
  if (s.perWeek) return Math.floor(k / s.perWeek) * 7 + Math.floor(((k % s.perWeek) * 7) / s.perWeek);
  return k * s.intervalDays;
}

/** "yyyy-MM-dd" of session `n` (1-based) of a course starting on `first`. */
function courseSessionDate(first: string | Date, n: number, s: CourseSchedule): string {
  const d = new Date(first);
  d.setDate(d.getDate() + courseDayOffset(n, s));
  return d.toISOString().split("T")[0];
}

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

  // Double-booking guard - only when therapist + full slot are given. A course
  // checks every session it will create (below), before anything is saved.
  if (input.doctorId && input.slot?.date && input.slot?.time) {
    const total = Number(input.totalSessions) || 0;
    const schedule = courseScheduleOf(input);
    const sessions = input.bookingKind === "course" && total > 1 && schedule ? total : 1;
    for (let n = 1; n <= sessions; n++) {
      const date = n === 1 ? input.slot.date : courseSessionDate(input.slot.date, n, schedule!);
      const clash = await findTherapistClash({
        doctorId: input.doctorId,
        date,
        start: input.therapyStartTime || input.slot.time,
        end: input.therapyEndTime,
      });
      if (clash) {
        return {
          ok: false,
          code: 409,
          message: `That therapist ${clash}${sessions > 1 ? ` on ${date} (session ${n})` : ""}.`,
        };
      }
    }
  }

  // No manual price changes: no discounts, and an intake's fee comes from the
  // Services catalogue, never the client.
  // ponytail: course prices are still computed client-side from the rate table.
  input = { ...input };
  // Only 1-4 a week is stored; anything else is dropped, not a failed save.
  input.sessionsPerWeek = courseScheduleOf(input)?.perWeek || undefined;
  delete input.discountAmount;
  delete input.discountType;
  delete input.promoCode;
  delete input.originalPrice;
  if (input.typeOfappointment && isIntake(input)) {
    const fee = await cataloguePrice(input.typeOfappointment);
    if (fee !== undefined) input.quotedPrice = fee;
  }

  // Money taken at booking becomes the first entry in `payments` (part-payment
  // allowed, never above the price). Later money goes through lib/payments.ts.
  const price = Number(input.quotedPrice) || 0;
  const firstPayment = Math.min(Number(input.paymentAmount) || 0, price);
  delete input.paymentAmount;
  delete input.paymentReceived;
  delete input.paymentReceivedAt;
  delete input.payments;
  const paymentFields =
    firstPayment > 0
      ? {
          paymentAmount: firstPayment,
          paymentReceived: firstPayment >= price,
          ...(firstPayment >= price ? { paymentReceivedAt: new Date() } : {}),
          payments: [
            { amount: firstPayment, method: input.paymentMethod, at: new Date(), by: opts.actor?.name ?? "", byRole: "" },
          ],
        }
      : {};

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
    // Fold only a TRUE repeat: same phone, same person, same service, into a
    // lead nobody has scheduled yet. A different name on the same (often
    // household) number is a different patient; a different service is a new
    // request; and a scheduled or ongoing booking (or a course follow-up, which
    // is always created "scheduled") is already being handled, so a new ask
    // after it is a new lead. Folding any of those would hide it from staff.
    // Names compare case/space-insensitively, so re-typing the same name
    // slightly differently still folds. No service on both sides is a match.
    const target = name.trim().toLowerCase();
    const service = input.service || "";
    const enquiries = await AppointmentBooking.find({ phonenumber, status: "enquiry" });
    const existing = enquiries.find(
      (lead) =>
        (lead.name ?? "").trim().toLowerCase() === target &&
        (lead.service || "") === service,
    );
    if (existing) {
      const repeatCount = (existing.repeatCount ?? 1) + 1;

      const detailBits: string[] = [];
      if (input.service) detailBits.push(`service: ${input.service}`);
      if (input.typeOfappointment)
        detailBits.push(`type: ${input.typeOfappointment}`);
      if (input.location) detailBits.push(`location: ${input.location}`);
      if (input.preferredReachOutTime?.from || input.preferredReachOutTime?.to) {
        detailBits.push(
          `time: ${input.preferredReachOutTime?.from ?? "?"}-${input.preferredReachOutTime?.to ?? "?"}`,
        );
      }
      if (Array.isArray(input.vitals) && input.vitals.length) {
        detailBits.push(`vitals: ${input.vitals.join(", ")}`);
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
      // A repeat can still bring details the first request didn't have.
      if (!existing.gender && input.gender) existing.gender = input.gender;
      if (!existing.age && input.age) existing.age = input.age;
      await existing.save();
      await ensureCustomerForAppointment(existing);
      logger.info("Booking repeat folded into existing lead", {
        enquiryId: existing.enquiryId,
        repeatCount,
      });
      return { ok: true, folded: true, appointment: existing, repeatCount };
    }
  }

  // How the booking reached us. Checked before the ID is allocated so a bad
  // value never burns an ENQ number. opts.source wins when set: it's how an
  // entry point that can only mean one thing (the public site) pins it.
  const resolvedSource = await resolveBookingSource({
    source: opts.source ?? input.source,
    referredByDoctorId: input.referredByDoctorId,
  });
  if (!resolvedSource.ok) {
    return { ok: false, code: resolvedSource.code, message: resolvedSource.message };
  }
  const sourceFields = resolvedSource.fields;

  // Allocate the booking / enquiry ID and persist.
  const seq = await nextSequence("enquiry");
  const enquiryId = `ENQ-${String(seq).padStart(4, "0")}`;

  const appointment = new AppointmentBooking({
    ...input,
    name,
    enquiryId,
    // Session 1 always gets number 1 regardless of what the client sent.
    // totalSessions captures the original count; sessionNumber is the moving pointer.
    sessionNumber: 1,
    status: input.status || "enquiry",
    // After ...input on purpose, so a client-sent referredByName can't stick.
    ...sourceFields,
    // Locked in by the server when the booking completes, never client-sent.
    therapistSplitPercent: undefined,
    ...paymentFields,
  });
  await appointment.save();
  logger.info("Booking created", {
    enquiryId,
    source: sourceFields.source,
    phonenumber,
  });

  // Side-effects for session 1 - identical for EVERY caller now.
  await ensureCustomerForAppointment(appointment);
  await maybeCreateInvoiceForAppointment({ appointment, actor: opts.actor });

  // ── Auto-generate follow-up sessions for multi-session courses ────────
  // When a course with totalSessions > 1 has a schedule (so many a week, or an
  // interval for older ones), create the remaining sessions as separate records
  // linked via packageOriginId. Each follow-up inherits the same therapist, time,
  // service, and price but gets its own date. Only session 1 gets invoice + customer.
  const totalSessions = Number(input.totalSessions) || 0;
  const schedule = courseScheduleOf(input);
  if (
    input.bookingKind === "course" &&
    totalSessions > 1 &&
    schedule &&
    input.slot?.date &&
    appointment._id
  ) {
    try {
      const followUps: any[] = [];
      for (let i = 2; i <= totalSessions; i++) {
        // Its date from the schedule; its time was already checked free by the
        // double-booking guard above.
        const dateStr = courseSessionDate(input.slot.date, i, schedule);

        const followUpSeq = await nextSequence("enquiry");
        const followUpEnquiryId = `ENQ-${String(followUpSeq).padStart(4, "0")}`;

        const followUp = new AppointmentBooking({
          // Copy relevant fields from session 1
          name,
          phonenumber: input.phonenumber,
          doctor: input.doctor,
          doctorId: input.doctorId,
          service: input.service,
          location: input.location,
          typeOfappointment: input.typeOfappointment,
          bookingKind: "course",
          packageServiceId: input.packageServiceId,
          // Session tracking
          sessionNumber: i,
          totalSessions,
          sessionIntervalDays: schedule.intervalDays || undefined,
          sessionsPerWeek: schedule.perWeek || undefined,
          packageOriginId: String(appointment._id),
          // Date for this session
          slot: { date: dateStr, time: input.slot.time },
          physioSlot: { date: dateStr, time: input.slot.time },
          therapyStartTime: input.slot.time,
          therapyEndTime: input.therapyEndTime,
          // Per-session price (split evenly for tracking; invoice covers the whole course on session 1)
          quotedPrice: Math.round((Number(input.quotedPrice) || 0) / totalSessions),
          // Status: scheduled but not ongoing (no payment/OTP needed per session)
          status: "scheduled",
          // Every session in a course came in the same way as session 1.
          ...sourceFields,
          enquiryId: followUpEnquiryId,
          // Link back to session 1
          activityLog: [
            {
              at: new Date().toISOString(),
              name: name,
              action: `Auto-generated follow-up session ${i} of ${totalSessions}`,
            },
          ],
        });
        await followUp.save();
        followUps.push(followUp);
        logger.info("Follow-up session created", {
          enquiryId: followUpEnquiryId,
          sessionNumber: i,
          totalSessions,
          date: dateStr,
        });
      }

      // Log the auto-generation on session 1 too
      appointment.activityLog.push({
        at: new Date().toISOString(),
        name: name,
        action: `Created ${totalSessions}-session course (${schedule.perWeek ? `${schedule.perWeek}x a week` : `${schedule.intervalDays}-day interval`}). Follow-ups: ${followUps.map((f) => f.enquiryId).join(", ")}`,
      });
      await appointment.save();
    } catch (err) {
      logger.error("[createBooking] follow-up generation failed", err);
      // Don't fail the whole booking — session 1 is already saved.
    }
  }

  return { ok: true, folded: false, appointment };
}
