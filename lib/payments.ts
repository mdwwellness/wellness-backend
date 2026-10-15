import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { Doctor } from "../models/doctorsModel.ts";

/**
 * Money on a booking. Part-payments are allowed: each payment is appended to
 * `payments`, `paymentAmount` is their running total, and `paymentReceived`
 * means fully paid. Nobody can pay more than is due, and nothing is ever
 * removed (a recorded payment can't be undone).
 *
 * A course's money lives on its first row; follow-up session rows
 * (packageOriginId) only point at it.
 */

export type PaymentUser = { _id?: unknown; role?: string; userEmail?: string; userfName?: string; userlName?: string };

const METHODS = ["cash", "upi", "card", "bank", "other"];

/** The row that holds the money for this visit. */
export async function moneyRowFor(row: any): Promise<any> {
  if (!row?.packageOriginId) return row;
  return (await AppointmentBooking.findById(row.packageOriginId).exec()) ?? row;
}

/** True when `user` is the therapist assigned to this booking. */
export async function isAssignedTherapist(user: PaymentUser | undefined, row: any): Promise<boolean> {
  if (!user || !row?.doctorId) return false;
  const doctor = await Doctor.findOne({
    $or: [{ userId: String(user._id ?? "") }, { email: user.userEmail }],
  }).lean();
  return !!doctor && (doctor as any).doctorId === row.doctorId;
}

/**
 * How much must be paid in total before this visit can start: the price of
 * every session up to and including this one. A single visit needs its full
 * fee; session 3 of a 9-session course needs 3/9 of the course price.
 *
 * ponytail: a one-row catalogue package without totalSessions counts as one
 * session (needs the full price up front); store totalSessions on it to pace it.
 */
export function paidNeededBeforeVisit(visitRow: any, moneyRow: any): number {
  const price = Number(moneyRow?.quotedPrice) || 0;
  const total = Number(moneyRow?.totalSessions) || 1;
  if (total <= 1) return price;
  const session = visitRow?.packageOriginId
    ? Number(visitRow.sessionNumber) || 1
    : (Number(visitRow?.sessionsCompleted) || 0) + 1;
  return Math.min(price, Math.round((price / total) * session));
}

/**
 * What must still be collected before this visit can be completed: its share of
 * the booking (the full fee on a single or last visit) plus every confirmed
 * add-on on this visit that isn't paid. Zero means it can be completed.
 * The start check only covers the booking share; add-ons are usually added
 * during the visit, so they're checked here.
 */
export function unpaidBeforeComplete(visitRow: any, moneyRow: any): { amount: number; addons: string[] } {
  const bookingShort = Math.max(0, paidNeededBeforeVisit(visitRow, moneyRow) - (Number(moneyRow?.paymentAmount) || 0));
  const addons = (visitRow?.recommendedServices ?? []).filter(
    (r: any) => r.status === "confirmed" && !r.paymentCollected,
  );
  const addonShort = addons.reduce((s: number, r: any) => s + (Number(r.quotedPrice) || 0), 0);
  return { amount: bookingShort + addonShort, addons: addons.map((r: any) => r.serviceName) };
}

export type RecordPaymentResult =
  | { ok: true; booking: any }
  | { ok: false; code: number; message: string };

/**
 * Record money received against the booking's price. Rejects anything that
 * isn't a positive amount within what's still due. Atomic against a parallel
 * payment: the write only lands if nobody else recorded one in between.
 */
export async function recordPayment(args: {
  row: any;
  amount: unknown;
  method: unknown;
  user?: PaymentUser;
}): Promise<RecordPaymentResult> {
  const money = await moneyRowFor(args.row);
  const price = Number(money.quotedPrice) || 0;
  const paid = Number(money.paymentAmount) || 0;
  const due = Math.max(0, price - paid);
  const amount = Number(args.amount);
  const method = METHODS.includes(String(args.method)) ? String(args.method) : "other";

  if (!(price > 0)) return { ok: false, code: 400, message: "This booking has no price yet." };
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, code: 400, message: "Enter the amount received." };
  }
  if (amount > due) {
    return { ok: false, code: 400, message: `Only ₹${due} is due on this booking.` };
  }

  const user = args.user;
  const by = user?.userfName
    ? `${user.userfName ?? ""} ${user.userlName ?? ""}`.trim()
    : (user?.userEmail ?? "");
  const total = paid + amount;
  const now = new Date();

  const booking = await AppointmentBooking.findOneAndUpdate(
    { _id: money._id, paymentAmount: money.paymentAmount ?? null },
    {
      $inc: { paymentAmount: amount },
      $push: { payments: { amount, method, at: now, by, byRole: user?.role ?? "" } },
      $set: {
        paymentMethod: method,
        paymentReceived: total >= price,
        ...(total >= price ? { paymentReceivedAt: now } : {}),
      },
    },
    { new: true },
  ).exec();
  if (!booking) {
    return { ok: false, code: 409, message: "Another payment was just recorded - refresh and try again." };
  }
  return { ok: true, booking };
}
