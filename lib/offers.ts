/**
 * Discount / Offer rules — BACKEND source of truth (pure, no DB).
 *
 * The `apply-offer` / `remove-offer` endpoints re-check every rule here and are
 * the ONLY authority on money: the browser sends an offer id/name, never a
 * price. This mirrors the dashboard's src/lib/offers.ts one-for-one so the two
 * never drift (see qoder-discount.md §4.4). Nothing in this file touches Mongo;
 * it only answers "what would this offer take off, and is it even allowed here?".
 */

/** Which kind of priced line an offer is being evaluated against. */
export type OfferLineKind = "main" | "course" | "add_on";

/** The slice of a stored offer this module needs (matches models/offerModel.ts). */
export type OfferLike = {
  _id?: unknown;
  name: string;
  code?: string | null;
  kind: "fixed" | "percent";
  amount: number;
  maxOff?: number | null;
  appliesTo?: "all" | "services" | "courses" | "add_ons";
  serviceIds?: string[];
  minRole?: "STAFF" | "ADMIN" | "SUPER_ADMIN";
  absorbedBy?: "company" | "therapist";
  validFrom?: string | Date | null;
  validUntil?: string | Date | null;
  totalUses?: number | null;
  usedCount?: number;
  oncePerPhone?: boolean;
  noteRequired?: boolean;
  active?: boolean;
};

/** The offer's `minRole` floors, ranked. */
const FLOOR_RANK: Record<string, number> = {
  STAFF: 1,
  ADMIN: 2,
  SUPER_ADMIN: 3,
};

/**
 * Every dashboard role mapped to a rank. Staff / Customer Care sit at the
 * floor (1); a Therapist (0) can never apply an offer — offers are an
 * office/back-office action (their own recommended add-on discount is a
 * separate, service-level concern).
 */
const ROLE_RANK: Record<string, number> = {
  THERAPIST: 0,
  STAFF: 1,
  CUSTOMER_CARE: 1,
  ADMIN: 2,
  SUPER_ADMIN: 3,
};

export type OfferContext = {
  /** The acting user's role string. */
  userRole: string;
  lineKind: OfferLineKind;
  /** Required only for `appliesTo: "services"` scoping. */
  serviceId?: string;
  /** Injectable for tests; defaults to now. */
  now?: Date;
  /** Precomputed by the caller (a query on prior bookings for this phone). */
  phoneAlreadyUsed?: boolean;
};

export type OfferComputation = {
  /** Rupees taken off the base (always >= 0, never more than base). */
  off: number;
  /** base - off, i.e. the final line price after the offer. */
  final: number;
  /** True when `maxOff` was the binding limit. */
  cappedByMax: boolean;
  /** True when the discount was clamped down to the base (couldn't exceed it). */
  clampedToBase: boolean;
};

/** Can this role apply an offer that requires `minRole`? */
export function roleAllows(userRole: string, minRole?: string): boolean {
  const u = ROLE_RANK[userRole] ?? 0;
  if (u === 0) return false; // therapist or unknown role: never
  const need = minRole ? (FLOOR_RANK[minRole] ?? 1) : 1;
  return u >= need;
}

function toDate(v?: string | Date | null): Date | null {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Compute the rupees an offer takes off a line's base (list) price.
 * Base is `originalPrice ?? quotedPrice` per the existing cascade — never a
 * number the browser invented. Percent applies to that base and is capped at
 * `maxOff` (and hard-capped at 100%); a fixed amount is capped at the base so a
 * line can never go negative.
 */
export function computeOfferOff(offer: OfferLike, base: number): OfferComputation {
  const safeBase = base > 0 ? base : 0;
  if (safeBase === 0 || offer.amount <= 0) {
    return { off: 0, final: safeBase, cappedByMax: false, clampedToBase: false };
  }

  let off = offer.kind === "percent" ? (safeBase * offer.amount) / 100 : offer.amount;

  // A percent offer above 100% is a giveaway by definition — clamp to the whole base.
  if (offer.kind === "percent" && offer.amount > 100) off = safeBase;

  let cappedByMax = false;
  if (offer.maxOff != null && off > offer.maxOff) {
    off = offer.maxOff;
    cappedByMax = true;
  }

  let clampedToBase = false;
  if (off > safeBase) {
    off = safeBase;
    clampedToBase = true;
  }
  if (off < 0) off = 0;

  const rounded = Math.round(off);
  return {
    off: rounded,
    final: Math.round(safeBase) - rounded,
    cappedByMax,
    clampedToBase,
  };
}

export type EligibilityResult = { ok: boolean; reason?: string };

/**
 * Is this offer allowed on this line right now? Runs the full server rule set
 * (§4.4): active → role → scope (appliesTo/service) → validity window → usage
 * cap → once-per-phone → must actually discount. Returns the first failing
 * reason so the caller can surface it.
 */
export function offerIsApplicable(
  offer: OfferLike,
  base: number,
  ctx: OfferContext,
): EligibilityResult {
  const now = ctx.now ?? new Date();

  if (offer.active === false) return { ok: false, reason: "Offer is off" };
  if (!roleAllows(ctx.userRole, offer.minRole))
    return { ok: false, reason: "Your role can't apply this offer" };

  const appliesTo = offer.appliesTo ?? "all";
  if (appliesTo === "courses" && ctx.lineKind !== "course")
    return { ok: false, reason: "Applies to courses only" };
  if (appliesTo === "add_ons" && ctx.lineKind !== "add_on")
    return { ok: false, reason: "Applies to add-ons only" };
  if (appliesTo === "services" && ctx.lineKind === "add_on")
    return { ok: false, reason: "Doesn't apply to add-ons" };
  if (
    appliesTo === "services" &&
    ctx.serviceId &&
    offer.serviceIds?.length &&
    !offer.serviceIds.includes(ctx.serviceId)
  )
    return { ok: false, reason: "Not valid for this service" };

  const from = toDate(offer.validFrom);
  const to = toDate(offer.validUntil);
  if (from && now < from) return { ok: false, reason: "Not started yet" };
  if (to && now > to) return { ok: false, reason: "Offer expired" };

  if (offer.totalUses != null && (offer.usedCount ?? 0) >= offer.totalUses)
    return { ok: false, reason: "Fully redeemed" };

  if (offer.oncePerPhone !== false && ctx.phoneAlreadyUsed)
    return { ok: false, reason: "Already used for this phone" };

  // A discount that takes nothing off is noise — don't offer it.
  if (computeOfferOff(offer, base).off <= 0)
    return { ok: false, reason: "No discount on this price" };

  return { ok: true };
}

/** The offers a given user may apply to a given line, in list order. */
export function applicableOffers(
  offers: OfferLike[],
  base: number,
  ctx: OfferContext,
): OfferLike[] {
  return offers.filter((o) => offerIsApplicable(o, base, ctx).ok);
}

/**
 * The one money guard the endpoints add on top of eligibility: an offer may
 * never push a line's final price below what the customer has already paid.
 * Returns the first failure (or ok) alongside the computed off/final so a
 * controller can build the $set in one step.
 */
export function offerMoney(
  offer: OfferLike,
  base: number,
  paid: number,
): OfferComputation & EligibilityResult {
  const c = computeOfferOff(offer, base);
  const alreadyPaid = paid > 0 ? paid : 0;
  if (c.final < alreadyPaid) {
    return {
      ...c,
      ok: false,
      reason: `Offer would price below the ₹${alreadyPaid} already received`,
    };
  }
  return { ...c, ok: true };
}
