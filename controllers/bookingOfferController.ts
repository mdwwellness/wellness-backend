import type { Request, Response } from "express";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import Offer from "../models/offerModel.ts";
import { moneyRowFor, addonKey } from "../lib/payments.ts";
import { addonPaid } from "../lib/bookingMoney.ts";
import { offerIsApplicable, offerMoney } from "../lib/offers.ts";
import { logger } from "../lib/logger.ts";

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

const findAddon = (row: any, key: string | undefined) =>
  key ? (row?.recommendedServices ?? []).find((r: any) => addonKey(r.serviceId, r.recommendedAt) === key) : undefined;

const lineEntry = (row: any, lineKind: string, key?: string) =>
  (row?.appliedOffers ?? []).find((a: any) =>
    a.lineKind === lineKind && (lineKind !== "add_on" || a.addonKey === key),
  );

/** Has this phone already redeemed this offer on another booking? */
async function phoneAlreadyUsed(phone: unknown, offerId: unknown, exceptId: unknown): Promise<boolean> {
  if (phone == null || phone === "") return false;
  const hit = await AppointmentBooking.findOne({
    phonenumber: phone,
    _id: { $ne: exceptId },
    "appliedOffers.offerId": String(offerId),
  })
    .select("_id")
    .lean();
  return Boolean(hit);
}

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
    const { offerId, code, lineKind = "main", addonKey: aKey, note } = req.body ?? {};

    const booking = await AppointmentBooking.findById(req.params.bookingId).exec();
    if (!booking) return res.status(404).send({ success: false, message: "Booking not found" });

    const offer = offerId
      ? await Offer.findById(offerId).exec()
      : code
        ? await Offer.findOne({ code: String(code).toUpperCase() }).exec()
        : null;
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
    const phoneUsed = offer.oncePerPhone !== false
      ? await phoneAlreadyUsed(doc.phonenumber, offer._id, doc._id)
      : false;

    const ctx = {
      userRole: user?.role ?? "",
      lineKind: (doc.bookingKind === "course" && kind === "main" ? "course" : kind) as "main" | "course" | "add_on",
      serviceId,
      now: new Date(),
      phoneAlreadyUsed: phoneUsed,
    };

    const elig = offerIsApplicable(offer.toObject(), base, ctx);
    if (!elig.ok) return res.status(400).send({ success: false, message: elig.reason });

    const money = offerMoney(offer.toObject(), base, paid);
    if (!money.ok) return res.status(400).send({ success: false, message: money.reason });
    if (offer.noteRequired && !String(note ?? "").trim()) {
      return res.status(400).send({ success: false, message: "A note is required for this offer." });
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
    const logAction = `Applied offer ${offer.name} (−₹${money.off})${kind === "add_on" ? " on add-on" : ""}`;
    const nowIso = new Date().toISOString();

    const write = kind === "add_on"
      ? await AppointmentBooking.findOneAndUpdate(
          {
            _id: doc._id,
            recommendedServices: { $elemMatch: { serviceId: addon.serviceId, recommendedAt: addon.recommendedAt } },
          },
          {
            $set: { "recommendedServices.$.quotedPrice": money.final },
            $push: { appliedOffers: entry, activityLog: { at: nowIso, userId: String(user?._id ?? ""), name: userLabel(user), action: logAction } },
          },
          { new: true },
        ).exec()
      : await AppointmentBooking.findOneAndUpdate(
          { _id: doc._id, quotedPrice: doc.quotedPrice ?? null },
          {
            $set: {
              originalPrice: base,
              quotedPrice: money.final,
              discountAmount: money.off,
              discountType: offer.kind,
              discountCode: offer.code || offer.name,
            },
            $push: { appliedOffers: entry, activityLog: { at: nowIso, userId: String(user?._id ?? ""), name: userLabel(user), action: logAction } },
          },
          { new: true },
        ).exec();

    if (!write) {
      await releaseOffer(offer._id); // roll back the reservation; the price moved under us
      return res.status(409).send({ success: false, message: "The booking just changed - refresh and try again." });
    }

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

    if (kind === "add_on") {
      const addon = findAddon(doc, aKey);
      if (!addon) return res.status(404).send({ success: false, message: "Add-on not found on this booking." });
      await AppointmentBooking.findOneAndUpdate(
        { _id: doc._id, recommendedServices: { $elemMatch: { serviceId: addon.serviceId, recommendedAt: addon.recommendedAt } } },
        { $set: { "recommendedServices.$.quotedPrice": entry.base }, $pull: { appliedOffers: { offerId: entry.offerId, addonKey: aKey } }, $push: { activityLog: log } },
        { new: true },
      ).exec();
    } else {
      const isCourse = doc.bookingKind === "course";
      await AppointmentBooking.findOneAndUpdate(
        { _id: doc._id },
        {
          $set: {
            quotedPrice: entry.base,
            ...(isCourse ? {} : { originalPrice: undefined }),
            discountAmount: 0,
            discountType: "fixed",
            discountCode: undefined,
          },
          $pull: { appliedOffers: { offerId: entry.offerId, lineKind: "main" } },
          $push: { activityLog: log },
        },
        { new: true },
      ).exec();
    }

    await releaseOffer(entry.offerId); // free the redemption
    logger.info("Offer removed", { bookingId: String(doc._id), offerId: entry.offerId });
    return res.status(200).send({ success: true, message: "Offer removed" });
  } catch (error: any) {
    return res.status(500).send({ success: false, message: error.message });
  }
};
