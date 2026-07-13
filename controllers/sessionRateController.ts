import type { Request, Response } from "express";
import SessionRate from "../models/sessionRateModel.ts";
import { logger } from "../lib/logger.ts";

const KEY = "global";

// Return the single global rate table, creating an empty one on first read.
export const getSessionRates = async (_req: Request, res: Response) => {
    try {
        let doc = await SessionRate.findOne({ key: KEY }).exec();
        if (!doc) doc = await SessionRate.create({ key: KEY, tiers: [] });
        return res.status(200).send({ success: true, data: doc });
    } catch (error: any) {
        return res.status(500).send({ success: false, message: error.message });
    }
};

// Replace the tier list wholesale (the editor sends the full table).
export const updateSessionRates = async (req: Request, res: Response) => {
    try {
        const tiers = Array.isArray(req.body?.tiers) ? req.body.tiers : null;
        if (!tiers) {
            return res
                .status(400)
                .send({ success: false, message: "`tiers` must be an array." });
        }

        const clean = [];
        for (const t of tiers) {
            const from = Number(t.from);
            const rate = Number(t.rate);
            const to =
                t.to === null || t.to === undefined || t.to === ""
                    ? null
                    : Number(t.to);
            if (!Number.isFinite(from) || from < 0 || !Number.isFinite(rate) || rate < 0) {
                return res.status(400).send({
                    success: false,
                    message: "Each tier needs a non-negative `from` and `rate`.",
                });
            }
            if (to !== null && (!Number.isFinite(to) || to < from)) {
                return res.status(400).send({
                    success: false,
                    message: "A tier's `to` must be a number ≥ its `from` (or empty for open-ended).",
                });
            }
            clean.push({ from, to, rate });
        }

        const doc = await SessionRate.findOneAndUpdate(
            { key: KEY },
            { $set: { tiers: clean } },
            { new: true, upsert: true },
        );
        logger.info("Session rates updated", { tiers: clean.length });
        return res
            .status(200)
            .send({ success: true, message: "Session rates saved", data: doc });
    } catch (error: any) {
        return res.status(500).send({ success: false, message: error.message });
    }
};
