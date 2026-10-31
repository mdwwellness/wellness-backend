// The video call for an online consultation: a Google Calendar event with a
// Meet link (lib/googleMeet.ts), made once the consultation has a confirmed
// slot, moved when the slot moves, removed when the booking is cancelled or
// deleted. Every booking write path calls syncBookingMeet after it saves.
//
// Meetings are left at Google's default access ("Trusted"): the customer opens
// the link and asks to join, and is only let in when admitted.

import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { createMeetEvent, deleteMeetEvent, googleMeetConfigured, moveMeetEvent } from "./googleMeet.ts";
import { isIntake } from "./lockedFields.ts";
import { logger } from "./logger.ts";

// When the visit has no end time.
const DEFAULT_MINUTES = 30;

type Meet = { link: string; eventId: string; start: string; end: string };

/** An online consultation intake, not a home visit or a course row. */
function isOnlineConsult(row: any): boolean {
  return row?.typeOfappointment === "consultation" && isIntake(row);
}

// slot.date is a Date at UTC midnight (or a "yyyy-MM-dd" string): its UTC day is the booked day.
function slotDay(row: any): string | null {
  const v = row?.slot?.date ?? row?.physioSlot?.date;
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

// Slot times are India time ("HH:MM", 24-hour). India has no DST.
function atIST(day: string, time: unknown): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? "").trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return new Date(`${day}T${m[1].padStart(2, "0")}:${m[2]}:00+05:30`);
}

/** When the call starts and ends. Same time order as the clash check and the invoice. */
export function visitWindow(row: any): { start: Date; end: Date } | null {
  const day = slotDay(row);
  const start = day && atIST(day, row.therapyStartTime || row.physioSlot?.time || row.slot?.time);
  if (!day || !start) return null;
  const end = atIST(day, row.therapyEndTime);
  return { start, end: end && end > start ? end : new Date(start.getTime() + DEFAULT_MINUTES * 60_000) };
}

/** Returns the call the booking has afterwards, or null. */
async function syncOnce(id: string): Promise<Meet | null> {
  const row: any = await AppointmentBooking.findById(id).lean();
  const meet: Meet | null = row?.meet?.eventId ? row.meet : null;
  // A finished call keeps its link as it was, for the record.
  if (!row || row.status === "completed") return meet;
  const live = isOnlineConsult(row) && (row.status === "scheduled" || row.status === "ongoing") && !!slotDay(row);

  if (!live) {
    if (!meet) return null;
    await deleteMeetEvent(meet.eventId);
    await AppointmentBooking.updateOne({ _id: id }, { $unset: { meet: 1 } });
    return null;
  }

  const when = visitWindow(row);
  if (!when) return meet; // a time we can't read: leave any link as it is
  const start = when.start.toISOString();
  const end = when.end.toISOString();

  if (!meet) {
    const made = await createMeetEvent({
      // No customer details: the event sits on the clinic's calendar.
      summary: `MDW Wellness online consultation (${row.enquiryId ?? id})`,
      start: when.start,
      end: when.end,
    });
    const next = { link: made.meetLink, eventId: made.eventId, start, end };
    const saved = await AppointmentBooking.updateOne({ _id: id }, { $set: { meet: next } });
    // Deleted while Google was busy: don't leave the event behind.
    if (!saved.matchedCount) {
      await deleteMeetEvent(made.eventId);
      return null;
    }
    return next;
  }
  if (meet.start !== start || meet.end !== end) {
    await moveMeetEvent(meet.eventId, when.start, when.end);
    await AppointmentBooking.updateOne({ _id: id }, { $set: { "meet.start": start, "meet.end": end } });
    return { ...meet, start, end };
  }
  return meet;
}

// ponytail: per-booking queue in this process, so two quick saves can't make
// two events. Fine on one Render instance; use a DB claim if it scales out.
const queue = new Map<string, Promise<Meet | null>>();

/**
 * Brings a booking's video call in line with its saved state, and returns the
 * call it has afterwards (null: none). Never throws: a Google failure is
 * logged (null) and the booking save still succeeds; the next save tries again.
 */
export function syncBookingMeet(row: any): Promise<Meet | null> {
  if (!row?._id || !googleMeetConfigured()) return Promise.resolve(null);
  if (!isOnlineConsult(row) && !row.meet?.eventId) return Promise.resolve(null);
  const id = String(row._id);
  const run = (queue.get(id) ?? Promise.resolve(null))
    .then(() => syncOnce(id))
    .catch((err) => {
      logger.error(`[meet] sync failed for booking ${id}`, err);
      return null;
    });
  queue.set(id, run);
  void run.finally(() => {
    if (queue.get(id) === run) queue.delete(id);
  });
  return run;
}

/** For a booking that was deleted outright. Never throws. */
export async function dropBookingMeet(row: any): Promise<void> {
  if (!row?.meet?.eventId || !googleMeetConfigured()) return;
  await deleteMeetEvent(row.meet.eventId).catch((err) =>
    logger.error(`[meet] delete failed for booking ${row._id}`, err),
  );
}
