import type { Request, Response } from "express";
import ClinicSettings from "../models/clinicSettingsModel.ts";
import { logger } from "../lib/logger.ts";

const KEY = "global";

export const getClinicSettings = async (_req: Request, res: Response) => {
  try {
    let doc = await ClinicSettings.findOne({ key: KEY }).exec();
    if (!doc) doc = await ClinicSettings.create({ key: KEY });
    return res.status(200).send({ success: true, data: doc });
  } catch (error: any) {
    return res.status(500).send({ success: false, message: error.message });
  }
};

export const updateClinicSettings = async (req: Request, res: Response) => {
  try {
    const updates: Record<string, number> = {};

    if (req.body?.bookingGapMinutes !== undefined) {
      const gap = Number(req.body.bookingGapMinutes);
      if (!Number.isFinite(gap) || gap < 0) {
        return res.status(400).send({
          success: false,
          message: "`bookingGapMinutes` must be a non-negative number.",
        });
      }
      updates.bookingGapMinutes = gap;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).send({
        success: false,
        message: "No valid settings provided.",
      });
    }

    const doc = await ClinicSettings.findOneAndUpdate(
      { key: KEY },
      { $set: updates },
      { new: true, upsert: true },
    );
    logger.info("Clinic settings updated", updates);
    return res.status(200).send({ success: true, message: "Settings saved", data: doc });
  } catch (error: any) {
    return res.status(500).send({ success: false, message: error.message });
  }
};
