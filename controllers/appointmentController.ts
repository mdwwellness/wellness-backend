import express from "express";
import type { Request, Response } from "express";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { Doctor } from "../models/doctorsModel.ts";
import Service from "../models/serviceModel.ts";
import { nextSequence } from "../lib/counters.ts";
import { logger } from "../lib/logger.ts";
import {
    ensureCustomerForAppointment,
    lockConfirmedAddonsToInvoice,
    maybeCreateInvoiceForAppointment,
    safeSyncInvoiceFromAppointment,
} from "../lib/invoiceGeneration.ts";
import { createBooking } from "../lib/bookingService.ts";

// Statuses considered "open" for public-form repeat folding (see addPublicEnquiry).
const OPEN_STATUSES = ["enquiry", "scheduled", "ongoing"];

// Back-office roles that see every appointment / enquiry record.
// THERAPIST is intentionally NOT in this set — therapists see only their
// own assigned records (filtered by doctorId).
const BACK_OFFICE_ROLES = new Set([
    "SUPER_ADMIN",
    "ADMIN",
    "STAFF",
    "CUSTOMER_CARE",
]);

export const addAppointmentsDetails = async (req: Request, res: Response) => {
    try {
        const actor = {
            name: (req.user as any)?.userfName
                ? `${(req.user as any).userfName ?? ""} ${(req.user as any).userlName ?? ""}`.trim()
                : undefined,
            email: (req.user as any)?.userEmail,
        };

        // All creation logic — validation, ID allocation, customer linkage, and
        // invoice generation — lives in the one createBooking() service, so this
        // dashboard path and the public path can never drift apart again.
        const result = await createBooking(req.body, {
            source: "dashboard",
            actor,
        });

        if (!result.ok) {
            return res
                .status(result.code)
                .send({ success: false, message: result.message });
        }

        return res.status(200).send({
            success: true,
            message: "Appointment booked",
            data: result.appointment,
        });
    } catch (error: any) {
        return res.status(500).send({
            success: false,
            message: error.message,
        });
    }
};


export const getAllAppointments = async (req: Request, res: Response) => {
    try {
        // Trust the server-verified user from JWT (set by userAuth middleware),
        // NOT the client-supplied ?role= query param — that was spoofable and
        // also broke for back-office roles other than SUPER_ADMIN.
        const role = req.user?.role;
        const userEmail = req.user?.userEmail;
        const userId = (req.user as any)?.id ?? (req.user as any)?._id;

        let appointmentdetails: any[] = [];

        if (role && BACK_OFFICE_ROLES.has(role)) {
            // Back-office staff (SUPER_ADMIN, ADMIN, STAFF, CUSTOMER_CARE)
            // see every appointment / enquiry record.
            appointmentdetails = await AppointmentBooking.find()
                .sort({ createdAt: -1 })
                .exec();
        } else if (role === "THERAPIST") {
            // Therapists see only the appointments assigned to them. Resolve
            // their Doctor profile by the linked userId (robust to email edits),
            // falling back to email for older records.
            const doctorQuery: any = userId
                ? { $or: [{ userId: String(userId) }, { email: userEmail }] }
                : { email: userEmail };
            const isExistingDoctor = await Doctor.findOne(doctorQuery).exec();
            if (isExistingDoctor) {
                const doctorId = isExistingDoctor.doctorId;
                appointmentdetails = await AppointmentBooking.find({ doctorId: doctorId })
                    .sort({ createdAt: -1 });
            } else {
                appointmentdetails = [];
            }
        } else {
            return res.status(403).json({
                success: false,
                message: "Forbidden: Role not allowed",
            });
        }

        return res.status(200).send({
            success: true,
            data: appointmentdetails,
        });
    } catch (error: any) {
        console.error("Error fetching details:", error);
        return res.status(500).send({
            success: false,
            message: error.message
        });
    }
};

export const deleteAppointment = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const deleted = await AppointmentBooking.findByIdAndDelete(id);

        if (!deleted) {
            return res.status(404).send({
                success: false,
                message: "Appointment not found",
            });
        }

        return res.status(200).send({
            success: true,
            message: "Appointment deleted successfully",
        });
    } catch (error: any) {
        res.status(500).send({
            success: false,
            message: error.message,
        });
    }
};

export const addAppointmentRecommendation = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { serviceId, serviceName, category, quotedPrice, slot } = req.body ?? {};

        if (!serviceId || typeof serviceId !== "string") {
            return res.status(400).send({
                success: false,
                message: "serviceId is required.",
            });
        }
        if (!serviceName || typeof serviceName !== "string") {
            return res.status(400).send({
                success: false,
                message: "serviceName is required.",
            });
        }
        if (quotedPrice == null || typeof quotedPrice !== "number" || quotedPrice < 0) {
            return res.status(400).send({
                success: false,
                message: "quotedPrice is required and must be a non-negative number.",
            });
        }

        const appointment = await AppointmentBooking.findById(id).exec();
        if (!appointment) {
            return res.status(404).send({
                success: false,
                message: "Appointment not found",
            });
        }

        if (appointment.appointmentKind === "recommended") {
            return res.status(400).send({
                success: false,
                message:
                    "Cannot add recommendations to a legacy recommended row. Open the parent appointment instead.",
            });
        }

        const actorName = (req.user as any)?.userfName
            ? `${(req.user as any).userfName ?? ""} ${(req.user as any).userlName ?? ""}`.trim()
            : (req.user as any)?.userEmail ?? "Therapist";

        const entry = {
            serviceId,
            serviceName: serviceName.trim(),
            category: category ?? "",
            quotedPrice,
            slot:
                slot?.date || slot?.time
                    ? { date: slot.date ?? "", time: slot.time ?? "" }
                    : undefined,
            recommendedAt: new Date().toISOString(),
            recommendedBy: actorName,
            status: "pending",
        };

        const logEntry = {
            at: entry.recommendedAt,
            userId: String((req.user as any)?.id ?? (req.user as any)?._id ?? ""),
            name: actorName,
            action: `Recommended add-on: ${entry.serviceName} (₹${quotedPrice})`,
        };

        const updated = await AppointmentBooking.findByIdAndUpdate(
            id,
            {
                $push: {
                    recommendedServices: entry,
                    activityLog: logEntry,
                },
            },
            { new: true },
        ).exec();

        if (!updated) {
            return res.status(404).send({
                success: false,
                message: "Appointment not found",
            });
        }

        logger.info("Service recommendation stacked on appointment", {
            appointmentId: id,
            serviceId,
        });

        return res.status(200).send({
            success: true,
            message: "Recommendation added to this visit",
            data: updated,
        });
    } catch (error: any) {
        return res.status(500).send({
            success: false,
            message: error.message,
        });
    }
};

export const confirmAppointmentRecommendation = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { serviceId, recommendedAt } = req.body ?? {};

        if (!serviceId || typeof serviceId !== "string") {
            return res.status(400).send({
                success: false,
                message: "serviceId is required.",
            });
        }
        if (!recommendedAt || typeof recommendedAt !== "string") {
            return res.status(400).send({
                success: false,
                message: "recommendedAt is required.",
            });
        }

        const appointment = await AppointmentBooking.findById(id).exec();
        if (!appointment) {
            return res.status(404).send({
                success: false,
                message: "Appointment not found",
            });
        }

        const recs = appointment.recommendedServices ?? [];
        const idx = recs.findIndex(
            (r) => r.serviceId === serviceId && r.recommendedAt === recommendedAt,
        );
        if (idx < 0) {
            return res.status(404).send({
                success: false,
                message: "Recommendation not found on this visit.",
            });
        }

        const actorName = (req.user as any)?.userfName
            ? `${(req.user as any).userfName ?? ""} ${(req.user as any).userlName ?? ""}`.trim()
            : (req.user as any)?.userEmail ?? "Staff";

        const confirmedAt = new Date().toISOString();
        const path = `recommendedServices.${idx}`;
        const updated = await AppointmentBooking.findByIdAndUpdate(
            id,
            {
                $set: {
                    [`${path}.status`]: "confirmed",
                    [`${path}.confirmedAt`]: confirmedAt,
                    [`${path}.confirmedBy`]: actorName,
                },
                $push: {
                    activityLog: {
                        at: confirmedAt,
                        userId: String((req.user as any)?.id ?? (req.user as any)?._id ?? ""),
                        name: actorName,
                        action: `Customer confirmed add-on: ${recs[idx].serviceName}`,
                    },
                },
            },
            { new: true },
        ).exec();

        const actor = {
            name: actorName,
            email: (req.user as any)?.userEmail,
        };
        if (updated) {
            await safeSyncInvoiceFromAppointment({ appointment: updated, actor });
        }

        return res.status(200).send({
            success: true,
            message: "Add-on confirmed for this visit",
            data: updated,
        });
    } catch (error: any) {
        return res.status(500).send({
            success: false,
            message: error.message,
        });
    }
};

export const setAddonPaymentStatus = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { serviceId, recommendedAt, collected } = req.body ?? {};

        if (!serviceId || typeof serviceId !== "string") {
            return res.status(400).send({
                success: false,
                message: "serviceId is required.",
            });
        }
        if (!recommendedAt || typeof recommendedAt !== "string") {
            return res.status(400).send({
                success: false,
                message: "recommendedAt is required.",
            });
        }
        if (typeof collected !== "boolean") {
            return res.status(400).send({
                success: false,
                message: "collected must be a boolean.",
            });
        }

        const appointment = await AppointmentBooking.findById(id).exec();
        if (!appointment) {
            return res.status(404).send({
                success: false,
                message: "Appointment not found",
            });
        }

        const recs = appointment.recommendedServices ?? [];
        const idx = recs.findIndex(
            (r) => r.serviceId === serviceId && r.recommendedAt === recommendedAt,
        );
        if (idx < 0) {
            return res.status(404).send({
                success: false,
                message: "Recommendation not found on this visit.",
            });
        }

        const actorName = (req.user as any)?.userfName
            ? `${(req.user as any).userfName ?? ""} ${(req.user as any).userlName ?? ""}`.trim()
            : (req.user as any)?.userEmail ?? "Staff";

        const path = `recommendedServices.${idx}`;
        const updated = await AppointmentBooking.findByIdAndUpdate(
            id,
            {
                $set: {
                    [`${path}.paymentCollected`]: collected,
                    [`${path}.paymentCollectedAt`]: collected
                        ? new Date().toISOString()
                        : null,
                },
                $push: {
                    activityLog: {
                        at: new Date().toISOString(),
                        userId: String((req.user as any)?.id ?? (req.user as any)?._id ?? ""),
                        name: actorName,
                        action: `${collected ? "Marked" : "Unmarked"} add-on payment collected: ${recs[idx].serviceName}`,
                    },
                },
            },
            { new: true },
        ).exec();

        const actor = {
            name: actorName,
            email: (req.user as any)?.userEmail,
        };
        if (updated) {
            await safeSyncInvoiceFromAppointment({ appointment: updated, actor });
        }

        return res.status(200).send({
            success: true,
            message: "Add-on payment status updated",
            data: updated,
        });
    } catch (error: any) {
        return res.status(500).send({
            success: false,
            message: error.message,
        });
    }
};

export const completeSession = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        // Look up the row first so we know the package total BEFORE incrementing.
        const existing = await AppointmentBooking.findById(id).exec();
        if (!existing) {
            return res.status(404).send({
                success: false,
                message: "Appointment not found",
            });
        }

        // Same package-resolution pattern as lib/invoiceGeneration.ts:228-231.
        const service = existing.packageServiceId
            ? await Service.findOne({ serviceId: existing.packageServiceId }).exec()
            : existing.service
                ? await Service.findOne({ name: existing.service }).exec()
                : null;
        const total = service?.packageCount ?? 1;

        // Ceiling guard: never complete past the package total. Atomic conditional
        // increment — only bumps when the current count (0 if the field is missing)
        // is still below `total`; returns null if the package is already complete.
        // This enforces the ceiling AND stays correct under concurrent completions
        // (the server, not the client, decides the count).
        const bumped = await AppointmentBooking.findOneAndUpdate(
            {
                _id: id,
                $expr: { $lt: [{ $ifNull: ["$sessionsCompleted", 0] }, total] },
            },
            { $inc: { sessionsCompleted: 1 } },
            { new: true },
        ).exec();
        if (!bumped) {
            // Already at/over the total — there is no session left to complete.
            return res.status(409).send({
                success: false,
                message: `Package already complete — all ${total} sessions done`,
                data: existing,
            });
        }

        const sessionsDone = bumped.sessionsCompleted ?? 0;
        const done = sessionsDone >= total;

        const actorName = (req.user as any)?.userfName
            ? `${(req.user as any).userfName ?? ""} ${(req.user as any).userlName ?? ""}`.trim()
            : (req.user as any)?.userEmail ?? "Therapist";

        const logEntry = {
            at: new Date().toISOString(),
            userId: String((req.user as any)?.id ?? (req.user as any)?._id ?? ""),
            name: actorName,
            action: done
                ? `Package complete — all ${total} sessions done`
                : `Session ${sessionsDone} of ${total} completed — schedule next visit`,
        };

        const actor = {
            name: actorName,
            email: (req.user as any)?.userEmail,
        };

        // Snapshot confirmed add-ons onto the invoice ledger — belt-and-suspenders:
        // add-ons now stay on the row too, but this guarantees the invoice keeps
        // them even if the row is later edited. A lock failure must not fail the
        // completion.
        try {
            await lockConfirmedAddonsToInvoice({ appointment: bumped, actor });
        } catch (err) {
            console.error(`[addon-lock] failed for appointment ${id}:`, err);
        }

        // Conditioned on the exact sessionsCompleted value this request just
        // observed: if a concurrent completion has since moved the counter
        // further, this write is a no-op (findOneAndUpdate returns null)
        // instead of blindly overwriting status/completedAt with a now-stale
        // decision. Whichever request's snapshot matches the CURRENT true
        // count at write time is always the most recent completion, so its
        // status write is always the correct final one.
        let finalUpdate = await AppointmentBooking.findOneAndUpdate(
            { _id: id, sessionsCompleted: sessionsDone },
            {
                status: done ? "completed" : "scheduled",
                ...(done ? { completedAt: new Date() } : { sessionNumber: sessionsDone + 1 }),
                // Add-ons are NOT cleared — they stay on the row (shown with a
                // check once confirmed) so they never vanish. Only the per-visit
                // checklist (arrived/performed/completed) resets for next visit.
                workChecklist: [],
                $push: { activityLog: logEntry },
            },
            { new: true },
        ).exec();

        if (!finalUpdate) {
            // Lost the race: another concurrent completion already advanced
            // sessionsCompleted past what this request saw, and that other
            // request's own status write already reflects the true final state.
            finalUpdate = await AppointmentBooking.findById(id).exec();
        }

        if (finalUpdate) {
            await safeSyncInvoiceFromAppointment({ appointment: finalUpdate, actor });
        }

        return res.status(200).send({
            success: true,
            message: done ? "Package complete" : `Session ${sessionsDone} of ${total} completed`,
            data: finalUpdate,
        });
    } catch (error: any) {
        return res.status(500).send({
            success: false,
            message: error.message,
        });
    }
};

export const updateAppointment = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const updateData = req.body;

        const updated = await AppointmentBooking.findByIdAndUpdate(
            id,
            updateData,
            { new: true },
        ).exec();
        if (!updated) {
            return res.status(404).send({
                success: false,
                message: "Appointment not found",
            });
        }

        // Auto-generate invoice when:
        // - session marked completed, OR
        // - online consultation slot is booked (see invoiceGeneration.ts)
        const actor = {
            name: (req.user as any)?.userfName
                ? `${(req.user as any).userfName ?? ""} ${(req.user as any).userlName ?? ""}`.trim()
                : undefined,
            email: (req.user as any)?.userEmail,
        };

        await safeSyncInvoiceFromAppointment({
            appointment: updated,
            actor,
        });

        return res.status(200).send({
            success: true,
            message: "Appointment updated successfully",
            data: updated,
        });
    } catch (error: any) {
        res.status(500).send({
            success: false,
            message: error.message,
        });
    }
};

// ── Public booking endpoint (NO auth) ─────────────────────────────────────────
// Used by the public mdw patient site's booking form. Simple per-IP rate limit.
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_PER_MINUTE = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

function tooManyRequests(ip: string): boolean {
    const now = Date.now();
    const bucket = rateLimitBuckets.get(ip);
    if (!bucket || bucket.resetAt < now) {
        rateLimitBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return false;
    }
    bucket.count++;
    return bucket.count > RATE_LIMIT_PER_MINUTE;
}

export const addPublicEnquiry = async (req: Request, res: Response) => {
    try {
        const ip =
            (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
            req.socket.remoteAddress ||
            "unknown";

        if (tooManyRequests(ip)) {
            return res.status(429).send({
                success: false,
                message: "Too many submissions. Please try again in a minute.",
            });
        }

        const {
            name,
            phonenumber,
            email,
            location,
            typeOfappointment,
            preferredReachOutTime,
            note,
            source,
            service,
            vitals,
        } = req.body;

        const input = {
            name,
            phonenumber,
            email: email || undefined,
            location: location || undefined,
            typeOfappointment: typeOfappointment || undefined,
            preferredReachOutTime: preferredReachOutTime || undefined,
            note: note || undefined,
            source: source || "public_booking_form",
            service: service || undefined,
            vitals: Array.isArray(vitals) && vitals.length ? vitals : undefined,
            status: "enquiry",
        };

        // Same createBooking() service the dashboard uses — so a public lead now
        // gets the SAME customer linkage + invoice handling + guards. Repeat
        // folding stays on for the public form.
        const result = await createBooking(input, {
            source: source || "public_booking_form",
            foldOpenRepeats: true,
        });

        if (!result.ok) {
            return res
                .status(result.code)
                .send({ success: false, message: result.message });
        }

        if (result.folded) {
            return res.status(200).send({
                success: true,
                message:
                    "Thanks! We already have your enquiry — our team will reach out, and we've noted your latest details.",
                data: {
                    enquiryId: result.appointment.enquiryId,
                    repeatCount: result.repeatCount,
                },
            });
        }

        return res.status(201).send({
            success: true,
            message: "Booking received — our team will reach out shortly.",
            data: { enquiryId: result.appointment.enquiryId },
        });
    } catch (error: any) {
        console.error("[addPublicEnquiry]", error);
        return res.status(500).send({
            success: false,
            message: "Server error — please try again.",
        });
    }
};
