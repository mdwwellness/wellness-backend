import type { Request, Response } from "express";
import Service from "../models/serviceModel.ts";
import { nextSequence } from "../lib/counters.ts";

export const addService = async (req: Request, res: Response) => {
    try {
        const { name, price, category } = req.body;
        if (!name || price === undefined || price === null || !category) {
            return res.status(400).send({
                success: false,
                message: "Name, price and category are required.",
            });
        }

        // Allocate the next sequential service ID (SRV-0001, SRV-0002, ...).
        const seq = await nextSequence("service");
        const serviceId = `SRV-${String(seq).padStart(4, "0")}`;

        const service = new Service({ ...req.body, serviceId });
        await service.save();

        return res.status(200).send({
            success: true,
            message: "Service added",
            data: service,
        });
    } catch (error: any) {
        return res.status(500).send({ success: false, message: error.message });
    }
};

export const getServices = async (_req: Request, res: Response) => {
    try {
        const services = await Service.find().sort({ createdAt: -1 }).exec();
        return res.status(200).send({ success: true, data: services });
    } catch (error: any) {
        return res.status(500).send({ success: false, message: error.message });
    }
};

export const updateService = async (req: Request, res: Response) => {
    try {
        const { serviceId } = req.params;
        // serviceId is immutable — never let the body overwrite it.
        const { serviceId: _ignore, ...updateData } = req.body;
        const updated = await Service.findOneAndUpdate(
            { serviceId },
            updateData,
            { new: true, runValidators: true },
        );
        if (!updated) {
            return res
                .status(404)
                .send({ success: false, message: "Service not found" });
        }
        return res
            .status(200)
            .send({ success: true, message: "Service updated", data: updated });
    } catch (error: any) {
        return res.status(500).send({ success: false, message: error.message });
    }
};

export const deleteService = async (req: Request, res: Response) => {
    try {
        const { serviceId } = req.params;
        const deleted = await Service.findOneAndDelete({ serviceId });
        if (!deleted) {
            return res
                .status(404)
                .send({ success: false, message: "Service not found" });
        }
        return res
            .status(200)
            .send({ success: true, message: "Service deleted" });
    } catch (error: any) {
        return res.status(500).send({ success: false, message: error.message });
    }
};
