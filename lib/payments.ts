import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { Doctor } from "../models/doctorsModel.ts";
import { addonPaid } from "./bookingMoney.ts";

/**
 * Money on a booking. Part-payments are allowed: each payment is appended to
 * `payments`, `paymentAmount` is their running total, and `paymentReceived`
 * means fully paid. Nobody can pay more than is due, and nothing is ever
 * removed (a recorded payment can't be undone).
 *
 * Where money lives:
 * - a booking (or a course's first row) holds its own price;
 * - a course follow-up row (packageOriginId) pays into the course's first row;
 * - a recommended add-on holds its own price and `paidAmount` on the row it was
 *   recommended on; a visit created for one of its later sessions (addonOf)
 *   pays into that add-on.
 */

export type PaymentUser = { _id?: unknown; role?: string; userEmail?: string; userfName?: string; userlName?: string };

const METHODS = ["cash", "upi", "card", "bank", "other"];

/** Key pinning one recommended add-on on a booking. */
export const addonKey = (serviceId: string, recommendedAt: string) => `${serviceId}|${recommendedAt}`;

const findAddon = (row: any, key: string | undefined) =>
  key ? (row?.recommendedServices ?? []).find((r: any) => addonKey(r.serviceId, r.recommendedAt) === key) : undefined;


/** Price of one session of an add-on. */
const addonPerSession = (r: any) =>
  Math.round((Number(r?.quotedPrice) || 0) / (Number(r?.sessions) || 1));

/** The row that holds the money for this visit. */
export async function moneyRowFor(row: any): Promise<any> {
  const id = row?.addonOf?.bookingId ?? row?.packageOriginId;
  if (!id) return row;
  return (await AppointmentBooking.findById(id).exec()) ?? row;
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

/** Still to collect before this visit can start (0 = it can start). */
export function shortBeforeStart(visitRow: any, moneyRow: any): number {
  if (visitRow?.addonOf) {
    const addon = findAddon(moneyRow, visitRow.addonOf.key);
    if (!addon) return 0;
    const needed = Math.min(
      Number(addon.quotedPrice) || 0,
      addonPerSession(addon) * (Number(visitRow.addonOf.session) || 1),
    );
    return Math.max(0, needed - addonPaid(addon));
  }
  return Math.max(0, paidNeededBeforeVisit(visitRow, moneyRow) - (Number(moneyRow?.paymentAmount) || 0));
}

/** Everything still owed for this visit's own money (the most that can be paid now). */
export function dueForVisit(visitRow: any, moneyRow: any): number {
  if (visitRow?.addonOf) {
    const addon = findAddon(moneyRow, visitRow.addonOf.key);
    return addon ? Math.max(0, (Number(addon.quotedPrice) || 0) - addonPaid(addon)) : 0;
  }
  return Math.max(0, (Number(moneyRow?.quotedPrice) || 0) - (Number(moneyRow?.paymentAmount) || 0));
}

/**
 * What must still be collected before this visit can be completed: its own
 * share (as at the start), plus the session of every confirmed add-on done in
 * this visit (the whole add-on if it's a single session). An add-on's later
 * sessions are paid at their own visits. Zero means it can be completed.
 */
export function unpaidBeforeComplete(visitRow: any, moneyRow: any): { amount: number; addons: string[] } {
  let amount = shortBeforeStart(visitRow, moneyRow);
  const addons: string[] = [];
  for (const r of visitRow?.recommendedServices ?? []) {
    if (r.status !== "confirmed" || r.firstInVisit === false) continue;
    const needed = (Number(r.sessions) || 1) > 1 ? addonPerSession(r) : Number(r.quotedPrice) || 0;
    const short = Math.max(0, needed - addonPaid(r));
    if (short > 0) {
      amount += short;
      addons.push(r.serviceName);
    }
  }
  return { amount, addons };
}

export type RecordPaymentResult =
  | { ok: true; booking: any }
  | { ok: false; code: number; message: string };

/**
 * Record money received. Without `addon` it goes to the visit's own money
 * (its booking, its course, or - on an add-on visit - that add-on); with
 * `addon` it goes to that add-on on `row`. Rejects anything that isn't a
 * positive amount within what's still due. Atomic against a parallel payment:
 * the write only lands if nobody else recorded one in between.
 */
export async function recordPayment(args: {
  row: any;
  amount: unknown;
  method: unknown;
  user?: PaymentUser;
  addon?: unknown;
}): Promise<RecordPaymentResult> {
  const doc = args.addon ? args.row : await moneyRowFor(args.row);
  const key = args.addon ? String(args.addon) : args.row?.addonOf?.key;
  const addon = key ? findAddon(doc, key) : undefined;
  if (key && !addon) return { ok: false, code: 404, message: "Add-on not found on this booking." };
  if (addon && addon.status !== "confirmed") {
    return { ok: false, code: 400, message: "The customer hasn't confirmed this add-on yet." };
  }

  const price = Number(addon ? addon.quotedPrice : doc.quotedPrice) || 0;
  const paid = addon ? addonPaid(addon) : Number(doc.paymentAmount) || 0;
  const due = Math.max(0, price - paid);
  const amount = Number(args.amount);
  const method = METHODS.includes(String(args.method)) ? String(args.method) : "other";

  if (!(price > 0)) return { ok: false, code: 400, message: "This booking has no price yet." };
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, code: 400, message: "Enter the amount received." };
  }
  if (amount > due) {
    return { ok: false, code: 400, message: `Only ₹${due} is due${addon ? ` on ${addon.serviceName}` : " on this booking"}.` };
  }

  const user = args.user;
  const by = user?.userfName
    ? `${user.userfName ?? ""} ${user.userlName ?? ""}`.trim()
    : (user?.userEmail ?? "");
  const total = paid + amount;
  const full = total >= price;
  const now = new Date();
  const entry = { amount, method, at: now, by, byRole: user?.role ?? "", ...(addon ? { for: addon.serviceName } : {}) };

  const booking = addon
    ? await AppointmentBooking.findOneAndUpdate(
        {
          _id: doc._id,
          recommendedServices: {
            $elemMatch: { serviceId: addon.serviceId, recommendedAt: addon.recommendedAt, paidAmount: addon.paidAmount ?? null },
          },
        },
        {
          $set: {
            "recommendedServices.$.paidAmount": total,
            "recommendedServices.$.paymentCollected": full,
            ...(full ? { "recommendedServices.$.paymentCollectedAt": now.toISOString() } : {}),
          },
          $push: { payments: entry },
        },
        { new: true },
      ).exec()
    : await AppointmentBooking.findOneAndUpdate(
        { _id: doc._id, paymentAmount: doc.paymentAmount ?? null },
        {
          $inc: { paymentAmount: amount },
          $push: { payments: entry },
          $set: {
            paymentMethod: method,
            paymentReceived: full,
            ...(full ? { paymentReceivedAt: now } : {}),
          },
        },
        { new: true },
      ).exec();
  if (!booking) {
    return { ok: false, code: 409, message: "Another payment was just recorded - refresh and try again." };
  }
  return { ok: true, booking };
}
