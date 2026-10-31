import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { Doctor } from "../models/doctorsModel.ts";
import { addonPaid } from "./bookingMoney.ts";
import { addonKey, courseSessionOf } from "./payments.ts";
import { canManageSplit } from "./therapistSplit.ts";

/**
 * What every booking row earns, split between therapist and company. The one
 * place this is worked out: Earnings, a therapist's Earnings tab and Analytics
 * all read it from the server (ISSUES #47, #49-#57). Owner's rules (2026-10-30):
 * 1. Courses and packages are earned per session: a session earns its share of
 *    the price, at the split of the therapist who did it.
 * 2. An add-on is earned by the therapist who did it (the visit's therapist for
 *    a same-visit session, the add-on visit's therapist for the others).
 * 3. An offer's absorbedBy is followed: "company" pays the therapist on the
 *    pre-offer price, "therapist" takes the discount out of their share.
 * A session counts as earned once it's done AND its share is paid; done but not
 * paid for is pending; not done yet is upcoming.
 */

/** Money in one state. discount: taken off the list price; due: still unpaid by the customer. */
type Bucket = { revenue: number; therapistCut: number; companyCut: number; discount: number; due: number };

export type PayoutPart = {
  doctorId: string;
  doctor: string;
  /** Hidden (undefined) from anyone who may not see splits. */
  splitPercent?: number | null;
  /** Sessions done (earned + pending). */
  sessions: number;
  /** Done and paid for. */
  earned: Bucket;
  /** Done, but the customer still owes `due` for them. */
  pending: Bucket;
  /** Not done yet (`due` is what's not paid in advance). */
  upcoming: Bucket;
  /** Already paid out to this therapist (therapistPayouts ledger). */
  paidOut: number;
  /** earned.therapistCut - paidOut (negative when overpaid). */
  owed: number;
};

type Line = {
  doctorId: string;
  doctor: string;
  split: number | null;
  amount: number;
  /** Pre-offer price and discount of this line, when an offer applies. */
  base?: number;
  off?: number;
  absorbedBy?: string;
  /** Taken off the list price (an offer, or an older row's originalPrice). */
  discount: number;
  done: boolean;
  /** Still unpaid by the customer. */
  due: number;
  /** A visit of its own (not a same-visit add-on). */
  visit: boolean;
};

type Ctx = { byId: Map<string, any>; splits: Map<string, number | null> };

const num = (v: unknown) => Number(v) || 0;
const zero = (): Bucket => ({ revenue: 0, therapistCut: 0, companyCut: 0, discount: 0, due: 0 });

/** Session i's share of `total` over n sessions; the shares add up to `total` exactly. */
const share = (total: number, n: number, i: number) =>
  Math.round((total * i) / n) - Math.round((total * (i - 1)) / n);

// 1e-9: 250 × 64.6 / 100 is 161.4999… in floating point, which would round down.
const pct = (x: number, split: number) => Math.round((x * split) / 100 + 1e-9);

/** Therapist and company share of one line. No split known: all of it stays with the company. */
export function cutOf(l: Pick<Line, "amount" | "split" | "base" | "off" | "absorbedBy">): Pick<Bucket, "revenue" | "therapistCut" | "companyCut"> {
  if (l.split == null) return { revenue: l.amount, therapistCut: 0, companyCut: l.amount };
  const therapistCut = !l.off
    ? pct(l.amount, l.split)
    : l.absorbedBy === "therapist"
      ? Math.max(0, pct(l.base ?? l.amount, l.split) - l.off)
      : pct(l.base ?? l.amount, l.split);
  return { revenue: l.amount, therapistCut, companyCut: l.amount - therapistCut };
}

/** The offer on a line of this money row, if any. */
const offerOn = (money: any, key?: string) =>
  (money?.appliedOffers ?? []).find((a: any) =>
    key ? a.lineKind === "add_on" && a.addonKey === key : a.lineKind !== "add_on",
  );

/** Paid so far on a booking's own price (older rows only had the flag). */
const paidOn = (money: any) => (money?.paymentReceived ? num(money.quotedPrice) : num(money?.paymentAmount));

/**
 * Session i of n of a line priced `price` (list price `list`, pre-offer
 * `offer.base`), with `paid` collected so far.
 */
function sessionLine(
  price: number, n: number, i: number, paid: number, offer: any,
  who: Pick<Line, "doctorId" | "doctor" | "split">, done: boolean, visit = true, list = price,
): Line {
  const amount = share(price, n, i);
  const covered = Math.min(amount, Math.max(0, paid - Math.round((price * (i - 1)) / n)));
  return {
    ...who,
    amount,
    ...(offer ? { base: share(num(offer.base), n, i), off: share(num(offer.off), n, i), absorbedBy: offer.absorbedBy ?? "company" } : {}),
    discount: Math.max(0, share(offer ? num(offer.base) : Math.max(list, price), n, i) - amount),
    done,
    due: amount - covered,
    visit,
  };
}

/** Every line row `r` earns. A cancelled row keeps only the sessions already done. */
function linesOf(r: any, ctx: Ctx): Line[] {
  const notes: any[] = r.sessionNotes ?? [];
  // Who did a session: the therapist stamped at its completion, else the row's.
  const who = (note?: any) => {
    const doctorId = note?.doctorId ?? r.doctorId ?? "";
    const split =
      note?.splitPercent ??
      (doctorId === (r.doctorId ?? "") ? r.therapistSplitPercent : undefined) ??
      ctx.splits.get(doctorId) ??
      null;
    return { doctorId, doctor: (note?.doctorId && note.therapist) || r.doctor || "", split };
  };
  const done = r.status === "completed";
  const lines: Line[] = [];

  if (r.addonOf?.bookingId) {
    // A later session of an add-on: priced and paid on the add-on itself.
    const host = ctx.byId.get(String(r.addonOf.bookingId));
    const rec = (host?.recommendedServices ?? []).find((a: any) => addonKey(a.serviceId, a.recommendedAt) === r.addonOf.key);
    if (rec?.status === "confirmed") {
      lines.push(sessionLine(num(rec.quotedPrice), num(rec.sessions) || 1, num(r.addonOf.session) || 1,
        addonPaid(rec), offerOn(host, r.addonOf.key), who(notes[0]), done));
    }
  } else if (courseSessionOf(r)) {
    // One session of a course booked a visit per session: the price lives on session 1's row.
    const { session, total } = courseSessionOf(r)!;
    const isFollowUp = r.packageOriginId && String(r.packageOriginId) !== String(r._id);
    const money = isFollowUp ? ctx.byId.get(String(r.packageOriginId)) : r;
    if (money) {
      lines.push(sessionLine(num(money.quotedPrice), total || num(money.totalSessions) || 1, session,
        paidOn(money), offerOn(money), who(notes[0]), done, true, num(money.originalPrice)));
    }
  } else {
    // A single visit, or a package kept on one row (sessionsCompleted counts its sessions).
    // ponytail: a catalogue package without totalSessions counts as one session,
    // like the payment gate (paidNeededBeforeVisit); store totalSessions to pace it.
    const n = num(r.totalSessions) || 1;
    // Sessions done are counted by checkout; only an older row marked completed
    // by hand, with no count at all, counts as fully done.
    const doneCount = Math.min(n, num(r.sessionsCompleted)) || (done ? n : 0);
    for (let i = 1; i <= n; i++) {
      const note = notes.find((s) => num(s.session) === i);
      lines.push(sessionLine(num(r.quotedPrice), n, i, paidOn(r), offerOn(r), who(note), i <= doneCount, true, num(r.originalPrice)));
    }
  }

  // Add-ons whose first session is done in this visit: earned by the therapist
  // of the visit that completed after it was recommended.
  for (const rec of r.recommendedServices ?? []) {
    if (rec.status !== "confirmed" || rec.firstInVisit === false) continue;
    const key = addonKey(rec.serviceId, rec.recommendedAt);
    const note = notes.find((s) => String(s.at ?? "") >= String(rec.recommendedAt ?? ""));
    // ponytail: an older add-on with several sessions and no schedule got no
    // visits for its later sessions, so only its first session is ever earned.
    lines.push(sessionLine(num(rec.quotedPrice), num(rec.sessions) || 1, 1, addonPaid(rec),
      offerOn(r, key), who(note), !!note || done, false));
  }
  return r.status === "cancelled" ? lines.filter((l) => l.done) : lines;
}

/**
 * What an older row's "paid" tick paid out, before the payout ledger: the old
 * Earnings page's cut, the split × the row's own money. null when not ticked,
 * already in the ledger, or no split is known.
 */
export function legacyTick(r: any, currentSplit?: number | null): { doctorId: string; amount: number } | null {
  if (!r.therapistPaid || (r.therapistPayouts ?? []).length) return null;
  const split = r.therapistSplitPercent ?? currentSplit;
  return split == null ? null : { doctorId: r.doctorId ?? "", amount: pct(num(r.paymentAmount ?? r.quotedPrice), split) };
}

/** The row's earnings per therapist (usually one part; more when a package changed hands). */
export function payoutOf(r: any, ctx: Ctx): PayoutPart[] {
  const parts = new Map<string, PayoutPart>();
  for (const l of linesOf(r, ctx)) {
    const p = parts.get(l.doctorId) ?? {
      doctorId: l.doctorId, doctor: l.doctor, splitPercent: l.split, sessions: 0,
      earned: zero(), pending: zero(), upcoming: zero(), paidOut: 0, owed: 0,
    };
    const c = cutOf(l);
    const bucket = !l.done ? p.upcoming : l.due > 0 ? p.pending : p.earned;
    bucket.revenue += c.revenue;
    bucket.therapistCut += c.therapistCut;
    bucket.companyCut += c.companyCut;
    bucket.discount += l.discount;
    bucket.due += l.due;
    if (l.done) {
      if (l.visit) p.sessions++;
      p.splitPercent = l.split; // the latest done session's split
    }
    parts.set(l.doctorId, p);
  }

  const legacy = legacyTick(r, ctx.splits.get(r.doctorId ?? ""));
  const ledger: any[] = r.therapistPayouts?.length ? r.therapistPayouts : legacy ? [legacy] : [];
  // Anyone paid out keeps a part, so what they were paid stays visible (and undoable).
  for (const e of ledger) {
    const id = e.doctorId ?? "";
    if (parts.has(id)) continue;
    const doctor = (r.sessionNotes ?? []).find((s: any) => s.doctorId === id)?.therapist || (id === r.doctorId ? r.doctor : "") || id;
    parts.set(id, { doctorId: id, doctor, splitPercent: null, sessions: 0, earned: zero(), pending: zero(), upcoming: zero(), paidOut: 0, owed: 0 });
  }
  for (const p of parts.values()) {
    p.paidOut = ledger.filter((e) => (e.doctorId ?? "") === p.doctorId).reduce((t, e) => t + num(e.amount), 0);
    p.owed = p.earned.therapistCut - p.paidOut;
  }
  // A bare lead (no price, nothing done, nothing paid) earns nothing to list.
  return [...parts.values()].filter((p) => p.sessions || p.paidOut || p.earned.revenue || p.pending.revenue || p.upcoming.revenue);
}

// Only what payoutOf reads, for the rows it has to look up.
const MONEY_FIELDS =
  "status doctorId doctor quotedPrice originalPrice paymentAmount paymentReceived totalSessions sessionsCompleted bookingKind " +
  "sessionIntervalDays sessionsPerWeek packageOriginId sessionNumber addonOf recommendedServices appliedOffers " +
  "therapistSplitPercent sessionNotes therapistPayouts therapistPaid";

/** Looks up the rows' money rows (course session 1, add-on hosts) and therapists' current splits. */
async function contextFor(plain: any[]): Promise<Ctx> {
  const byId = new Map(plain.map((r) => [String(r._id), r]));
  const missing = new Set<string>();
  for (const r of plain) {
    const id = r.addonOf?.bookingId ?? (r.packageOriginId && String(r.packageOriginId) !== String(r._id) ? r.packageOriginId : null);
    if (id && !byId.has(String(id))) missing.add(String(id));
  }
  if (missing.size) {
    for (const m of await AppointmentBooking.find({ _id: { $in: [...missing] } }, MONEY_FIELDS).lean()) {
      byId.set(String(m._id), m);
    }
  }
  const doctorIds = new Set<string>();
  for (const r of plain) {
    if (r.doctorId) doctorIds.add(r.doctorId);
    for (const s of r.sessionNotes ?? []) if (s.doctorId) doctorIds.add(s.doctorId);
  }
  const doctors: any[] = doctorIds.size
    ? await Doctor.find({ doctorId: { $in: [...doctorIds] } }, { doctorId: 1, splitPercent: 1 }).lean()
    : [];
  return { byId, splits: new Map(doctors.map((d) => [d.doctorId, d.splitPercent ?? null])) };
}

const toPlain = (r: any) => (typeof r?.toObject === "function" ? r.toObject() : r);

/**
 * The rows as plain objects, each with its `payout` parts. A viewer who may not
 * see splits gets none (not in the parts, nor in the row's own split fields or
 * payout ledger), and a therapist only gets their own part.
 */
export async function withPayouts(rows: any[], viewer?: { role?: string; doctorId?: string | null }): Promise<any[]> {
  const plain = rows.map(toPlain);
  const ctx = await contextFor(plain);
  const showSplit = canManageSplit(viewer?.role);
  return plain.map((r) => {
    let parts = payoutOf(r, ctx);
    if (viewer?.role === "THERAPIST") parts = parts.filter((p) => p.doctorId === viewer.doctorId);
    if (showSplit) return { ...r, payout: parts };
    const { therapistSplitPercent: _s, therapistPayouts: _l, ...row } = r;
    return {
      ...row,
      sessionNotes: (r.sessionNotes ?? []).map(({ splitPercent: _n, ...s }: any) => s),
      payout: parts.map(({ splitPercent: _p, ...p }) => p),
    };
  });
}

/**
 * Pay a therapist what they're owed on a booking (`paid: true`), or undo what
 * was paid (`paid: false`). The amount comes from payoutOf, never the client,
 * and is recorded with the split it was paid at, so it can't move later (#53,
 * #54). Atomic against a parallel click: the write only lands if the ledger
 * didn't change in between.
 */
export async function recordPayout(args: {
  row: any;
  doctorId?: unknown;
  paid: unknown;
  user?: { role?: string; userEmail?: string; userfName?: string; userlName?: string };
}): Promise<{ ok: true; booking: any } | { ok: false; code: number; message: string }> {
  const row = toPlain(args.row);
  const doctorId = String(args.doctorId ?? row.doctorId ?? "");
  const ctx = await contextFor([row]);
  const part = payoutOf(row, ctx).find((p) => p.doctorId === doctorId);
  if (!doctorId || !part) return { ok: false, code: 404, message: "This therapist has no earnings on this booking." };

  let amount: number;
  if (args.paid === true) {
    if (part.splitPercent == null) return { ok: false, code: 400, message: "Set this therapist's split first." };
    if (part.owed <= 0) return { ok: false, code: 400, message: "Nothing is owed to this therapist on this booking." };
    amount = part.owed;
  } else {
    if (part.paidOut <= 0) return { ok: false, code: 400, message: "Nothing has been paid out on this booking." };
    amount = -part.paidOut;
  }

  const user = args.user;
  const by = user?.userfName ? `${user.userfName ?? ""} ${user.userlName ?? ""}`.trim() : (user?.userEmail ?? "");
  const now = new Date();
  const ledger: any[] = row.therapistPayouts ?? [];
  // An older row's "paid" tick goes into the ledger first, whoever is paid now,
  // so nothing it covered is lost once the ledger takes over.
  const tick = legacyTick(row, ctx.splits.get(row.doctorId ?? ""));
  const legacy = tick && tick.amount > 0 ? [{ ...tick, at: row.therapistPaidAt ?? now, by: "" }] : [];
  // The split this was paid at stays, whatever the therapist's % becomes later.
  const lock = doctorId === row.doctorId && row.therapistSplitPercent == null
    ? { therapistSplitPercent: part.splitPercent }
    : {};

  const booking = await AppointmentBooking.findOneAndUpdate(
    { _id: row._id, $expr: { $eq: [{ $size: { $ifNull: ["$therapistPayouts", []] } }, ledger.length] } },
    { $push: { therapistPayouts: { $each: [...legacy, { doctorId, amount, at: now, by }] } }, $set: lock },
    { new: true },
  ).exec();
  if (!booking) return { ok: false, code: 409, message: "This payout just changed - refresh and try again." };
  return { ok: true, booking };
}
