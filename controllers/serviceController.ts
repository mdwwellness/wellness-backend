import type { Request, Response } from "express";
import Service from "../models/serviceModel.ts";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import Invoice from "../models/invoiceModel.ts";
import { nextSequence } from "../lib/counters.ts";
import { logger } from "../lib/logger.ts";

function packageFieldsInvalid(body: any): boolean {
    if (!body?.isPackage) return false;
    const count = body.packageCount;
    const unit = body.packageUnit;
    return count === undefined || count === null || Number(count) < 1 || !unit;
}

export const addService = async (req: Request, res: Response) => {
    try {
        const { name, originalPrice, discountedPrice } = req.body;
        const missingPrice = [originalPrice, discountedPrice].some(
            (v) => v === undefined || v === null,
        );
        if (!name || missingPrice) {
            return res.status(400).send({
                success: false,
                message: "Name, original price and discounted price are required.",
            });
        }

        if (packageFieldsInvalid(req.body)) {
            return res.status(400).send({
                success: false,
                message: "A package needs at least 1 session and a unit (sessions/weeks/months).",
            });
        }

        // Allocate the next sequential service ID (SRV-0001, SRV-0002, ...).
        const seq = await nextSequence("service");
        const serviceId = `SRV-${String(seq).padStart(4, "0")}`;

        const service = new Service({ ...req.body, serviceId });
        await service.save();
        logger.info("Service created", { serviceId });

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
        // serviceId is immutable - never let the body overwrite it.
        const { serviceId: _ignore, ...updateData } = req.body;

        if (packageFieldsInvalid(updateData)) {
            return res.status(400).send({
                success: false,
                message: "A package needs at least 1 session and a unit (sessions/weeks/months).",
            });
        }

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

        const [appointments, invoices] = await Promise.all([
            AppointmentBooking.find({
                $or: [
                    { packageServiceId: serviceId },
                    { "recommendedServices.serviceId": serviceId },
                ],
            })
                .select("enquiryId")
                .lean(),
            Invoice.find({
                $or: [
                    { package_ref: serviceId },
                    { "locked_addon_items.serviceId": serviceId },
                ],
            })
                .select("invoice_id")
                .lean(),
        ]);
        const totalCount = appointments.length + invoices.length;
        if (totalCount > 0) {
            const bookingIds = appointments
                .map((a: any) => a.enquiryId)
                .filter(Boolean);
            const invoiceIds = invoices
                .map((i: any) => i.invoice_id)
                .filter(Boolean);
            const preview = [...bookingIds, ...invoiceIds].slice(0, 6).join(", ");
            const more = totalCount > 6 ? ` +${totalCount - 6} more` : "";
            return res.status(409).send({
                success: false,
                message: `Cannot delete - used by ${totalCount} record(s): ${preview}${more}. Remove or reassign these first.`,
                blockedBy: { appointments: bookingIds, invoices: invoiceIds },
            });
        }

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
