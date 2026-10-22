import type { Request, Response } from "express";
import Offer from "../models/offerModel.ts";
import { nextSequence } from "../lib/counters.ts";
import { logger } from "../lib/logger.ts";

/** The editable offer fields (everything except the server-owned bookkeeping). */
const WRITABLE = [
  "name",
  "code",
  "kind",
  "amount",
  "maxOff",
  "appliesTo",
  "serviceIds",
  "minRole",
  "absorbedBy",
  "validFrom",
  "validUntil",
  "totalUses",
  "oncePerPhone",
  "noteRequired",
  "active",
] as const;

const pick = (body: any) => {
  const out: any = {};
  for (const k of WRITABLE) if (body[k] !== undefined) out[k] = body[k];
  // A blank code means "no code", not a unique empty string.
  if (out.code === "" || out.code === null) out.code = undefined;
  return out;
};

const validKind = (kind: unknown) => kind === "fixed" || kind === "percent";

export const getOffers = async (_req: Request, res: Response) => {
  try {
    const offers = await Offer.find().sort({ createdAt: -1 }).exec();
    return res.status(200).send({ success: true, data: offers });
  } catch (error: any) {
    return res.status(500).send({ success: false, message: error.message });
  }
};

export const getOffer = async (req: Request, res: Response) => {
  try {
    const offer = await Offer.findOne({ offerId: req.params.offerId }).exec();
    if (!offer) return res.status(404).send({ success: false, message: "Offer not found" });
    return res.status(200).send({ success: true, data: offer });
  } catch (error: any) {
    return res.status(500).send({ success: false, message: error.message });
  }
};

export const addOffer = async (req: Request, res: Response) => {
  try {
    const data = pick(req.body);
    if (!data.name || !validKind(data.kind) || data.amount === undefined) {
      return res.status(400).send({
        success: false,
        message: "Name, kind (fixed/percent) and amount are required.",
      });
    }
    const seq = await nextSequence("offer");
    const offerId = `OFF-${String(seq).padStart(4, "0")}`;
    const user = req.user as any;
    const offer = new Offer({
      ...data,
      offerId,
      createdBy: {
        name: user?.userfName ? `${user.userfName ?? ""} ${user.userlName ?? ""}`.trim() : (user?.userEmail ?? ""),
        at: new Date().toISOString(),
      },
    });
    await offer.save();
    logger.info("Offer created", { offerId });
    return res.status(200).send({ success: true, message: "Offer added", data: offer });
  } catch (error: any) {
    if (error?.code === 11000) {
      return res.status(409).send({ success: false, message: "That offer code is already in use." });
    }
    return res.status(500).send({ success: false, message: error.message });
  }
};

export const updateOffer = async (req: Request, res: Response) => {
  try {
    const { offerId } = req.params;
    // offerId / usedCount are server-owned; never taken from the body.
    const data = pick(req.body);
    if (data.kind !== undefined && !validKind(data.kind)) {
      return res.status(400).send({ success: false, message: "kind must be fixed or percent." });
    }
    const updated = await Offer.findOneAndUpdate({ offerId }, data, {
      new: true,
      runValidators: true,
    }).exec();
    if (!updated) return res.status(404).send({ success: false, message: "Offer not found" });
    return res.status(200).send({ success: true, message: "Offer updated", data: updated });
  } catch (error: any) {
    if (error?.code === 11000) {
      return res.status(409).send({ success: false, message: "That offer code is already in use." });
    }
    return res.status(500).send({ success: false, message: error.message });
  }
};

export const deleteOffer = async (req: Request, res: Response) => {
  try {
    const deleted = await Offer.findOneAndDelete({ offerId: req.params.offerId }).exec();
    if (!deleted) return res.status(404).send({ success: false, message: "Offer not found" });
    logger.info("Offer deleted", { offerId: req.params.offerId });
    return res.status(200).send({ success: true, message: "Offer deleted" });
  } catch (error: any) {
    return res.status(500).send({ success: false, message: error.message });
  }
};
