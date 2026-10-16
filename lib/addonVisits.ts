import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { nextSequence } from "./counters.ts";
import { findTherapistClash } from "./bookingService.ts";
import { addonKey } from "./payments.ts";

/**
 * Scheduling for a recommended add-on. Its first session is on `slot.date` at
 * `slot.time`, further ones every `intervalDays`. A session on the same day as
 * the visit it was recommended on is done in that visit; every other session
 * becomes its own visit (a row with addonOf), always with the booking's own
 * therapist, so it gets its own code, verify and complete.
 */

export const DURATIONS = [30, 60, 90, 120];

/** "YYYY-MM-DD" in India time. */
const todayKey = () => new Date().toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" }).slice(0, 10);

/** The visit's own day as "YYYY-MM-DD" (today when it has none). */
export function visitDayKey(booking: any): string {
  const d = booking?.slot?.date ?? booking?.physioSlot?.date;
  if (!d) return todayKey();
  return typeof d === "string" ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10);
}

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const endTime = (start: string, minutes: number) => {
  const [h, m] = start.split(":").map(Number);
  const t = h * 60 + m + minutes;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

/** Every session of the add-on with its date, and whether it's done in the visit itself. */
export function addonSessions(rec: any, booking: any): { session: number; date: string; inVisit: boolean }[] {
  const n = Number(rec.sessions) || 1;
  const every = Number(rec.intervalDays) || 0;
  const visitDay = visitDayKey(booking);
  // A finished (or cancelled) visit can't take a session: all become visits.
  const open = booking?.status !== "completed" && booking?.status !== "cancelled";
  return Array.from({ length: n }, (_, i) => {
    const date = addDays(rec.slot.date, i * every);
    return { session: i + 1, date, inVisit: open && i === 0 && date === visitDay };
  });
}

export type ScheduleInput = { slot?: { date?: string; time?: string }; durationMin?: unknown; intervalDays?: unknown; sessions?: number };

/**
 * Check a recommended add-on's schedule: valid date/time not in the past,
 * a known length, an interval when it has several sessions, a therapist on the
 * booking, and no clash with that therapist's other visits. Returns the fields
 * to store, or an error message.
 */
export async function checkAddonSchedule(
  booking: any,
  input: ScheduleInput,
): Promise<{ ok: true; fields: Record<string, unknown> } | { ok: false; code: number; message: string }> {
  if (!booking.doctorId) return { ok: false, code: 400, message: "Assign a therapist to this booking first." };
  if (booking.status === "cancelled") return { ok: false, code: 400, message: "This booking is cancelled." };
  const date = String(input.slot?.date ?? "");
  const time = String(input.slot?.time ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(time)) {
    return { ok: false, code: 400, message: "Pick the date and time it will be done." };
  }
  if (date < todayKey()) return { ok: false, code: 400, message: "That date is in the past." };
  const durationMin = DURATIONS.includes(Number(input.durationMin)) ? Number(input.durationMin) : 60;
  const sessions = Number(input.sessions) || 1;
  const intervalDays = Number(input.intervalDays) || 0;
  if (sessions > 1 && !(intervalDays >= 1 && intervalDays <= 60)) {
    return { ok: false, code: 400, message: "Pick how often the sessions repeat." };
  }

  const rec = { slot: { date, time }, sessions, intervalDays };
  const end = endTime(time, durationMin);
  for (const s of addonSessions(rec, booking)) {
    if (s.inVisit) continue;
    const clash = await findTherapistClash({ doctorId: booking.doctorId, date: s.date, start: time, end, excludeId: booking._id });
    if (clash) {
      return { ok: false, code: 409, message: `${booking.doctor ?? "The therapist"} ${clash} on ${s.date}.` };
    }
  }
  return {
    ok: true,
    fields: {
      slot: { date, time },
      durationMin,
      ...(sessions > 1 ? { intervalDays } : {}),
      firstInVisit: addonSessions(rec, booking)[0].inVisit,
    },
  };
}

/** Create a visit for every add-on session not done in the visit itself. */
export async function createAddonVisits(booking: any, rec: any, actorName: string): Promise<any[]> {
  if (!rec?.slot?.date || !rec?.slot?.time) return []; // older add-ons had no schedule
  const n = Number(rec.sessions) || 1;
  const end = endTime(rec.slot.time, Number(rec.durationMin) || 60);
  const created: any[] = [];
  for (const s of addonSessions(rec, booking)) {
    if (s.inVisit) continue;
    const seq = await nextSequence("enquiry");
    const visit = await new AppointmentBooking({
      name: booking.name,
      phonenumber: booking.phonenumber,
      email: booking.email,
      location: booking.location,
      customer_id: booking.customer_id,
      source: booking.source,
      doctor: booking.doctor,
      doctorId: booking.doctorId,
      service: rec.serviceName,
      typeOfappointment: "appointment",
      bookingKind: "course",
      status: "scheduled",
      // slot only: physioSlot would also list it on the Enquiries page.
      slot: { date: s.date, time: rec.slot.time },
      therapyStartTime: rec.slot.time,
      therapyEndTime: end,
      addonOf: { bookingId: String(booking._id), key: addonKey(rec.serviceId, rec.recommendedAt), session: s.session },
      enquiryId: `ENQ-${String(seq).padStart(4, "0")}`,
      activityLog: [
        {
          at: new Date().toISOString(),
          name: actorName,
          action: `${rec.serviceName} - session ${s.session} of ${n}, from ${booking.enquiryId ?? "booking"}`,
        },
      ],
    }).save();
    created.push(visit);
  }
  return created;
}
