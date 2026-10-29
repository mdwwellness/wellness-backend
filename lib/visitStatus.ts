// A booking's status in the Appointments list (client list B2 #9), worked out
// here once so the office and every therapist see the same thing: a therapist
// only receives their own visits, so the dashboard can't work it out alone.
//   therapist assigned, no code sent -> otp_pending
//   office sent the code             -> visit_pending
//   therapist entered the code       -> session_live
//   every visit done                 -> completed
// A booking goes by its first visit not yet done (a package's next session or
// an add-on visit, overdue ones included); a visit listed on its own goes by
// itself. null (no therapist yet, or cancelled): the stored status shows.
import AppointmentBooking from "../models/appointmentsBookingModel.ts";

export type VisitStatus = "otp_pending" | "visit_pending" | "session_live" | "completed";

// Only what the rule reads, so nothing else about another therapist's visit
// is even loaded.
const STATUS_FIELDS = "status doctorId doctor visitOtpSentAt visitOtpVerified slot physioSlot packageOriginId addonOf";

const isOpen = (v: any) => v.status !== "completed" && v.status !== "cancelled";

/** "yyyy-MM-dd HH:mm" of when a visit starts, for ordering; "~" (last) without a date. */
function startKey(v: any): string {
  const d = v.slot?.date || v.physioSlot?.date;
  const t = d ? new Date(d) : null;
  if (!t || Number.isNaN(t.getTime())) return "~";
  return `${t.toISOString().slice(0, 10)} ${String(v.slot?.time || v.physioSlot?.time || "00:00").padStart(5, "0")}`;
}

/** The id of the booking this row is a visit of, or null when it's a booking itself. */
function bookingIdOf(r: any): string | null {
  if (r.addonOf?.bookingId) return String(r.addonOf.bookingId);
  return r.packageOriginId && String(r.packageOriginId) !== String(r._id) ? String(r.packageOriginId) : null;
}

export function visitStatusOf(booking: any, visits: any[]): VisitStatus | null {
  const all = [booking, ...visits];
  const open = all.filter(isOpen).sort((a, b) => startKey(a).localeCompare(startKey(b)))[0];
  if (!open) return all.some((v) => v.status === "completed") ? "completed" : null;
  if (open.visitOtpVerified) return "session_live";
  if (open.visitOtpSentAt) return "visit_pending";
  return open.doctorId || open.doctor ? "otp_pending" : null;
}

/** The rows as plain objects, each with its `visitStatus`, from all its booking's visits. */
export async function withVisitStatus(rows: any[]): Promise<any[]> {
  const plain = rows.map((r) => (typeof r?.toObject === "function" ? r.toObject() : r));
  const ids = plain.filter((r) => !bookingIdOf(r)).map((r) => String(r._id));
  const visits: any[] = ids.length
    ? await AppointmentBooking.find(
        { $or: [{ packageOriginId: { $in: ids } }, { "addonOf.bookingId": { $in: ids } }] },
        STATUS_FIELDS,
      ).lean()
    : [];
  const visitsOf = new Map<string, any[]>();
  for (const v of visits) {
    const id = bookingIdOf(v);
    if (id) visitsOf.set(id, [...(visitsOf.get(id) ?? []), v]);
  }
  return plain.map((r) => ({
    ...r,
    visitStatus: visitStatusOf(r, bookingIdOf(r) ? [] : (visitsOf.get(String(r._id)) ?? [])),
  }));
}
