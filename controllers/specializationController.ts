import type { Request, Response } from "express";
import { Specialization } from "../models/specializationModel.ts";
import { logger } from "../lib/logger.ts";

export const addSpecialization = async (req: Request, res: Response) => {
    try {
        const { value, label } = req.body;
        if (!value || !label) {
            return res.status(400).send({
                success: false,
                message: "Value and label are required.",
            });
        }

        const normalizedValue = String(value).trim().toLowerCase();
        const existing = await Specialization.findOne({
            value: normalizedValue,
        }).exec();
        if (existing) {
            return res.status(409).send({
                success: false,
                message: `Specialization "${label}" already exists.`,
            });
        }

        const specialization = new Specialization({
            value: normalizedValue,
            label,
        });
        await specialization.save();
        logger.info("Specialization created", { value: normalizedValue });

        return res.status(200).send({
            success: true,
            message: "Specialization added",
            data: specialization,
        });
    } catch (error: any) {
        return res.status(500).send({ success: false, message: error.message });
    }
};

export const getSpecializations = async (_req: Request, res: Response) => {
    try {
        const specializations = await Specialization.find()
            .sort({ label: 1 })
            .exec();
        return res.status(200).send({ success: true, data: specializations });
    } catch (error: any) {
        return res.status(500).send({ success: false, message: error.message });
    }
};

export const deleteSpecialization = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const deleted = await Specialization.findByIdAndDelete(id);
        if (!deleted) {
            return res
                .status(404)
                .send({ success: false, message: "Specialization not found" });
        }
        return res
            .status(200)
            .send({ success: true, message: "Specialization deleted" });
    } catch (error: any) {
        return res.status(500).send({ success: false, message: error.message });
    }
};
