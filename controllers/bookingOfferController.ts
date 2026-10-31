import type { Request, Response } from "express";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import Offer from "../models/offerModel.ts";
import { moneyRowFor, addonKey } from "../lib/payments.ts";
import { addonPaid } from "../lib/bookingMoney.ts";
import { offerIsApplicable, offerMoney } from "../lib/offers.ts";
import { logger } from "../lib/logger.ts";
import { safeSyncInvoiceFromAppointment } from "../lib/invoiceGeneration.ts";

/**
 * Apply / remove an Offer on one priced line of a booking. The server is the
 * only authority on money: the client names the offer (id or code) and which
 * line, never a rupee figure. We recompute the discount from the line's base
 * (originalPrice ?? quotedPrice) and re-run every lib/offers.ts rule.
 *
 * A line may hold only ONE offer at a time (remove before applying another).
 * `usedCount` is reserved atomically before the booking write and rolled back
 * if that write loses a race, so the usage cap can't be over-drawn.
 */

const userLabel = (user: any) =>
  user?.userfName ? `${user.userfName ?? ""} ${user.userlName ?? ""}`.trim() : (user?.userEmail ?? "");

// The line's price just changed, so the booking's invoice must show it (ISSUES
// #42).
const syncInvoice = (booking: any, user: any) =>
  booking && safeSyncInvoiceFromAppointment({ appointment: booking, actor: { name: userLabel(user), email: user?.userEmail } });

const findAddon = (row: any, key: string | undefined) =>
  key ? (row?.recommendedServices ?? []).find((r: any) => addonKey(r.serviceId, r.recommendedAt) === key) : undefined;

/**
 * "Paid in full" follows the booking's new price (ISSUES #55): an offer down to
 * exactly what was paid settles it, removing one after payment reopens it. An
 * older row had only the flag, no amount, and stays paid.
 */
const paidFlags = (doc: any, price: number) => {
  const full = (!!doc.paymentReceived && doc.paymentAmount == null) || (Number(doc.paymentAmount) || 0) >= price;
  return { paymentReceived: full, ...(full && !doc.paymentReceived ? { paymentReceivedAt: new Date() } : {}) };
};

const lineEntry = (row: any, lineKind: string, key?: string) =>
  (row?.appliedOffers ?? []).find((a: any) =>
    a.lineKind === lineKind && (lineKind !== "add_on" || a.addonKey === key),
  );

const isHex24 = (s?: string) => !!s && /^[0-9a-fA-F]{24}$/.test(s);

/** Find an offer by human offerId, Mongo _id, or promo code (first match wins). */
async function resolveOffer(offerId?: string, code?: string) {
  const clauses: any[] = [];
  if (offerId) {
    clauses.push({ offerId });
    if (isHex24(offerId)) clauses.push({ _id: offerId });
  }
  if (code) clauses.push({ code: String(code).toUpperCase() });
  if (!clauses.length) return null;
  return Offer.findOne(clauses.length > 1 ? { $or: clauses } : clauses[0]).exec();
}

/** The booking (ENQ id) on which this phone already redeemed this offer, if any. */
async function phoneUsedOn(phone: unknown, offerId: unknown, exceptId: unknown): Promise<string | null> {
  if (phone == null || phone === "") return null;
  const hit: any = await AppointmentBooking.findOne({
    phonenumber: phone,
    _id: { $ne: exceptId },
    "appliedOffers.offerId": String(offerId),
  })
    .select("enquiryId")
    .lean();
  return hit ? hit.enquiryId || String(hit._id) : null;
}

// Only these roles may apply a once-per-phone offer again, with a reason.
const REPEAT_ROLES = new Set(["ADMIN", "SUPER_ADMIN"]);

const bumpOffer = (offerId: unknown, totalUses: number | null | undefined) => {
  const cond: any = { _id: offerId };
  if (totalUses != null) cond.usedCount = { $lt: totalUses };
  return Offer.findOneAndUpdate(cond, { $inc: { usedCount: 1 } }, { new: true }).exec();
};
const releaseOffer = (offerId: unknown) =>
  Offer.findOneAndUpdate({ _id: offerId, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } }).exec();

export const applyOffer = async (req: Request, res: Response) => {
  let bumpedOfferId: unknown = null;
  try {
    const user: any = req.user;
    const { offerId, code, lineKind = "main", addonKey: aKey, note, repeat } = req.body ?? {};

    const booking = await AppointmentBooking.findById(req.params.bookingId).exec();
    if (!booking) return res.status(404).send({ success: false, message: "Booking not found" });

    const offer = await resolveOffer(offerId, code);
    if (!offer) return res.status(404).send({ success: false, message: "Offer not found" });

    const kind = lineKind === "add_on" ? "add_on" : "main";
    if (kind === "main" && offer.appliesTo === "add_ons") {
      return res.status(400).send({ success: false, message: "This offer applies to add-ons only." });
    }
    if (kind === "add_on" && !aKey) {
      return res.status(400).send({ success: false, message: "Add-on key is required to discount an add-on." });
    }

    const doc = await moneyRowFor(booking);
    const addon = kind === "add_on" ? findAddon(doc, aKey) : undefined;
    if (kind === "add_on" && !addon) {
      return res.status(404).send({ success: false, message: "Add-on not found on this booking." });
    }
    if (doc._id && booking?._id && String(doc._id) !== String(booking._id) && kind === "add_on") {
      // Add-on lines live on the money row; make sure we look them up there.
    }

    if (lineEntry(doc, kind, aKey)) {
      return res.status(409).send({ success: false, message: "This line already has an offer. Remove it first." });
    }

    const base = kind === "add_on"
      ? Number(addon?.quotedPrice) || 0
      : (Number(doc.originalPrice) || Number(doc.quotedPrice) || 0);
    const paid = kind === "add_on" ? addonPaid(addon) : Number(doc.paymentAmount) || 0;

    const serviceId = kind === "add_on" ? addon?.serviceId : doc.packageServiceId;
    const ctx = {
      userRole: user?.role ?? "",
      lineKind: (doc.bookingKind === "course" && kind === "main" ? "course" : kind) as "main" | "course" | "add_on",
      serviceId,
      now: new Date(),
    };

    // Once-per-phone is checked last (below), so an expired or capped offer
    // says so instead of asking to apply it again.
    const elig = offerIsApplicable(offer.toObject(), base, ctx);
    if (!elig.ok) return res.status(400).send({ success: false, message: elig.reason });

    const money = offerMoney(offer.toObject(), base, paid);
    if (!money.ok) return res.status(400).send({ success: false, message: money.reason });
    if (offer.noteRequired && !String(note ?? "").trim()) {
      return res.status(400).send({ success: false, message: "A note is required for this offer." });
    }

    // Once per phone: an Admin or Super Admin may apply it again on purpose,
    // with a reason. The dashboard asks first (code OFFER_REPEAT_CONFIRM).
    const usedOn = offer.oncePerPhone !== false
      ? await phoneUsedOn(doc.phonenumber, offer._id, doc._id)
      : null;
    const canRepeat = REPEAT_ROLES.has(user?.role);
    if (usedOn && !(repeat === true && canRepeat)) {
      const used = `${doc.name || "This customer"} already used ${offer.name} on ${usedOn}.`;
      if (!canRepeat) {
        return res.status(400).send({ success: false, message: `${used} Only an Admin or Super Admin can apply it again.` });
      }
      return res.status(409).send({ success: false, code: "OFFER_REPEAT_CONFIRM", message: used });
    }
    if (usedOn && !String(note ?? "").trim()) {
      return res.status(400).send({ success: false, message: "Add a reason to apply this offer again." });
    }

    // Reserve a redemption (atomic against the usage cap).
    const bumped = await bumpOffer(offer._id, offer.totalUses);
    if (!bumped) return res.status(409).send({ success: false, message: "This offer was just fully redeemed." });
    bumpedOfferId = offer._id;

    const entry = {
      offerId: String(offer._id),
      offerName: offer.name,
      code: offer.code ?? "",
      kind: offer.kind,
      amount: offer.amount,
      off: money.off,
      base,
      lineKind: kind,
      ...(kind === "add_on" ? { addonKey: aKey } : {}),
      absorbedBy: offer.absorbedBy ?? "company",
      note: String(note ?? "").trim(),
      appliedBy: { name: userLabel(user), at: new Date().toISOString() },
    };
    const logAction = `Applied offer ${offer.name} (−₹${money.off})${kind === "add_on" ? " on add-on" : ""}${
      usedOn ? ` again for this phone, first used on ${usedOn}. Reason: ${String(note).trim()}` : ""
    }`;
    const nowIso = new Date().toISOString();

    const write = kind === "add_on"
      ? await AppointmentBooking.findOneAndUpdate(
          {
            _id: doc._id,
            // The amount paid too, so a payment landing in between can't leave the flag stale.
            recommendedServices: { $elemMatch: { serviceId: addon.serviceId, recommendedAt: addon.recommendedAt, paidAmount: addon.paidAmount ?? null } },
          },
          {
            $set: { "recommendedServices.$.quotedPrice": money.final, "recommendedServices.$.paymentCollected": addonPaid(addon) >= money.final },
            $push: { appliedOffers: entry, activityLog: { at: nowIso, userId: String(user?._id ?? ""), name: userLabel(user), action: logAction } },
          },
          { new: true },
        ).exec()
      : await AppointmentBooking.findOneAndUpdate(
          { _id: doc._id, quotedPrice: doc.quotedPrice ?? null, paymentAmount: doc.paymentAmount ?? null },
          {
            $set: {
              originalPrice: base,
              quotedPrice: money.final,
              discountAmount: money.off,
              discountType: offer.kind,
              discountCode: offer.code || offer.name,
              ...paidFlags(doc, money.final),
            },
            $push: { appliedOffers: entry, activityLog: { at: nowIso, userId: String(user?._id ?? ""), name: userLabel(user), action: logAction } },
          },
          { new: true },
        ).exec();

    if (!write) {
      await releaseOffer(offer._id); // roll back the reservation; the price moved under us
      return res.status(409).send({ success: false, message: "The booking just changed - refresh and try again." });
    }

    await syncInvoice(write, user);
    logger.info("Offer applied", { bookingId: String(doc._id), offerId: String(offer._id), off: money.off });
    return res.status(200).send({ success: true, message: "Offer applied", data: { off: money.off, final: money.final, booking: write } });
  } catch (error: any) {
    if (bumpedOfferId) await releaseOffer(bumpedOfferId);
    return res.status(500).send({ success: false, message: error.message });
  }
};

export const removeOffer = async (req: Request, res: Response) => {
  try {
    const user: any = req.user;
    const { lineKind = "main", addonKey: aKey } = req.body ?? {};
    const kind = lineKind === "add_on" ? "add_on" : "main";

    const booking = await AppointmentBooking.findById(req.params.bookingId).exec();
    if (!booking) return res.status(404).send({ success: false, message: "Booking not found" });
    const doc = await moneyRowFor(booking);

    const entry = lineEntry(doc, kind, aKey);
    if (!entry) return res.status(400).send({ success: false, message: "No offer on this line." });

    const nowIso = new Date().toISOString();
    const logAction = `Removed offer ${entry.offerName}`;
    const log = { at: nowIso, userId: String(user?._id ?? ""), name: userLabel(user), action: logAction };

    let updated;
    if (kind === "add_on") {
      const addon = findAddon(doc, aKey);
      if (!addon) return res.status(404).send({ success: false, message: "Add-on not found on this booking." });
      updated = await AppointmentBooking.findOneAndUpdate(
        { _id: doc._id, recommendedServices: { $elemMatch: { serviceId: addon.serviceId, recommendedAt: addon.recommendedAt, paidAmount: addon.paidAmount ?? null } } },
        { $set: { "recommendedServices.$.quotedPrice": entry.base, "recommendedServices.$.paymentCollected": addonPaid(addon) >= entry.base }, $pull: { appliedOffers: { offerId: entry.offerId, addonKey: aKey } }, $push: { activityLog: log } },
        { new: true },
      ).exec();
    } else {
      const isCourse = doc.bookingKind === "course";
      updated = await AppointmentBooking.findOneAndUpdate(
        { _id: doc._id, paymentAmount: doc.paymentAmount ?? null },
        {
          $set: {
            quotedPrice: entry.base,
            ...(isCourse ? {} : { originalPrice: undefined }),
            discountAmount: 0,
            discountType: "fixed",
            discountCode: undefined,
            ...paidFlags(doc, entry.base),
          },
          $pull: { appliedOffers: { offerId: entry.offerId, lineKind: "main" } },
          $push: { activityLog: log },
        },
        { new: true },
      ).exec();
    }

    if (!updated) return res.status(409).send({ success: false, message: "The booking just changed - refresh and try again." });
    await releaseOffer(entry.offerId); // free the redemption
    await syncInvoice(updated, user);
    logger.info("Offer removed", { bookingId: String(doc._id), offerId: entry.offerId });
    return res.status(200).send({ success: true, message: "Offer removed" });
  } catch (error: any) {
    return res.status(500).send({ success: false, message: error.message });
  }
};
