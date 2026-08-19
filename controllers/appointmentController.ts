import express from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { Request, Response } from "express";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import Customer from "../models/customerModel.ts";
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
import { bookingLedger } from "../lib/bookingMoney.ts";

// Statuses considered "open" for public-form repeat folding (see addPublicEnquiry).
const OPEN_STATUSES = ["enquiry", "scheduled", "ongoing"];

// Back-office roles that see every appointment / enquiry record.
// THERAPIST is intentionally NOT in this set - therapists see only their
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

        // All creation logic - validation, ID allocation, customer linkage, and
        // invoice generation - lives in the one createBooking() service, so this
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
        // NOT the client-supplied ?role= query param - that was spoofable and
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
        const { serviceId, serviceName, category, quotedPrice, sessions, slot } = req.body ?? {};

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
            ...(typeof sessions === "number" && sessions > 1 ? { sessions } : {}),
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
            action: `Recommended add-on: ${entry.serviceName}${entry.sessions ? ` (${entry.sessions} sessions)` : ""} (₹${quotedPrice})`,
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

/** Key pinning an add-on OTP to one specific recommendation. */
const addonKey = (serviceId: string, recommendedAt: string) =>
    `${serviceId}|${recommendedAt}`;

/**
 * Send a consent code for ONE recommended add-on.
 *
 * Confirming an add-on used to be staff ticking a box on the customer's behalf.
 * The code is the customer's own proof of consent to the charge.
 */
export const sendAddonOtp = async (req: Request, res: Response) => {
    try {
        const { serviceId, recommendedAt } = req.body ?? {};
        if (!serviceId || !recommendedAt) {
            return res.status(400).send({
                success: false,
                message: "serviceId and recommendedAt are required.",
            });
        }
        const appt = await AppointmentBooking.findById(req.params.id).exec();
        if (!appt) {
            return res.status(404).send({ success: false, message: "Appointment not found" });
        }
        const exists = (appt.recommendedServices ?? []).some(
            (r) => r.serviceId === serviceId && r.recommendedAt === recommendedAt,
        );
        if (!exists) {
            return res.status(404).send({
                success: false,
                message: "Recommendation not found on this visit.",
            });
        }

        const code = String(crypto.randomInt(1000, 10000));
        appt.addonOtpHash = await bcrypt.hash(code, 10);
        appt.addonOtpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
        appt.addonOtpTarget = addonKey(serviceId, recommendedAt);
        await appt.save();
        // Returned so the exec can send it via wa.me (same manual channel as the
        // visit OTP).
        return res.status(200).send({ success: true, code });
    } catch (error: any) {
        console.error("[sendAddonOtp]", error);
        return res.status(500).send({ success: false, message: "Server error" });
    }
};

export const confirmAppointmentRecommendation = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { serviceId, recommendedAt, code } = req.body ?? {};

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

        // Consent gate: the customer's code, not staff's word. Pinned to THIS
        // add-on, so a code sent for one service can't confirm another.
        if (
            !appointment.addonOtpHash ||
            !appointment.addonOtpExpiresAt ||
            appointment.addonOtpExpiresAt < new Date() ||
            appointment.addonOtpTarget !== addonKey(serviceId, recommendedAt)
        ) {
            return res.status(400).send({
                success: false,
                message: "Send the customer a confirmation code first.",
            });
        }
        const codeOk = await bcrypt.compare(
            String(code ?? "").trim(),
            appointment.addonOtpHash,
        );
        if (!codeOk) {
            return res.status(400).send({ success: false, message: "Incorrect code." });
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
                    // Consume the code so it can't confirm a second add-on.
                    addonOtpHash: null,
                    addonOtpExpiresAt: null,
                    addonOtpTarget: null,
                },
                $push: {
                    activityLog: {
                        at: confirmedAt,
                        userId: String((req.user as any)?.id ?? (req.user as any)?._id ?? ""),
                        name: actorName,
                        action: `Customer confirmed add-on by code: ${recs[idx].serviceName}`,
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

// ── Per-visit proof-of-presence OTP ──────────────────────────────────────────
// The executive taps "send" → a fresh code is stored (hashed, 15-min expiry) and
// returned so it can be sent to the customer via wa.me. The therapist enters what
// the customer reads back → verify → completeSession consumes the verification.

export const sendVisitOtp = async (req: Request, res: Response) => {
  try {
    const appt = await AppointmentBooking.findById(req.params.id).exec();
    if (!appt) {
      return res.status(404).send({ success: false, message: "Appointment not found" });
    }
    // Crypto-random 4-digit code (not Math.random).
    const code = String(crypto.randomInt(1000, 10000));
    appt.visitOtpHash = await bcrypt.hash(code, 10);
    appt.visitOtpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
    appt.visitOtpVerified = false;
    await appt.save();
    // Code returned so the exec can send it via wa.me (manual interim channel).
    return res.status(200).send({ success: true, code });
  } catch (error: any) {
    console.error("[sendVisitOtp]", error);
    return res.status(500).send({ success: false, message: "Server error" });
  }
};

export const verifyVisitOtp = async (req: Request, res: Response) => {
  try {
    const { code } = req.body ?? {};
    const appt = await AppointmentBooking.findById(req.params.id).exec();
    if (!appt) {
      return res.status(404).send({ success: false, message: "Appointment not found" });
    }
    if (
      !appt.visitOtpHash ||
      !appt.visitOtpExpiresAt ||
      appt.visitOtpExpiresAt < new Date()
    ) {
      return res.status(400).send({ success: false, message: "No active code - send a new one." });
    }
    const ok = await bcrypt.compare(String(code ?? "").trim(), appt.visitOtpHash);
    if (!ok) {
      return res.status(400).send({ success: false, message: "Incorrect code." });
    }
    appt.visitOtpVerified = true;
    await appt.save();
    return res.status(200).send({ success: true, message: "Visit verified." });
  } catch (error: any) {
    console.error("[verifyVisitOtp]", error);
    return res.status(500).send({ success: false, message: "Server error" });
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

        // Per-visit proof-of-presence: no checkout until this visit's OTP is
        // verified. Consumed below on success, so every session needs a fresh one.
        if (!existing.visitOtpVerified) {
            return res.status(400).send({
                success: false,
                message: "Verify the visit OTP before checkout.",
            });
        }

        // Same package-resolution pattern as lib/invoiceGeneration.ts:228-231.
        const service = existing.packageServiceId
            ? await Service.findOne({ serviceId: existing.packageServiceId }).exec()
            : existing.service
                ? await Service.findOne({ name: existing.service }).exec()
                : null;
        // Total visits: a catalogue package's count, else an ad-hoc booking's
        // stable session count (totalSessions). sessionNumber is NOT used - it's
        // repurposed below as the current-session pointer.
        const total =
            service?.packageCount ?? existing.totalSessions ?? 1;

        // Ceiling guard: never complete past the package total. Atomic conditional
        // increment - only bumps when the current count (0 if the field is missing)
        // is still below `total`; returns null if the package is already complete.
        // This enforces the ceiling AND stays correct under concurrent completions
        // (the server, not the client, decides the count).
        const bumped = await AppointmentBooking.findOneAndUpdate(
            {
                _id: id,
                $expr: { $lt: [{ $ifNull: ["$sessionsCompleted", 0] }, total] },
            },
            {
                $inc: { sessionsCompleted: 1 },
                // Consume the verification so the next visit needs a fresh OTP.
                $set: { visitOtpVerified: false, visitOtpHash: null, visitOtpExpiresAt: null },
            },
            { new: true },
        ).exec();
        if (!bumped) {
            // Already at/over the total - there is no session left to complete.
            return res.status(409).send({
                success: false,
                message: `Package already complete - all ${total} sessions done`,
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
                ? `Package complete - all ${total} sessions done`
                : `Session ${sessionsDone} of ${total} completed - schedule next visit`,
        };

        const actor = {
            name: actorName,
            email: (req.user as any)?.userEmail,
        };

        // Snapshot confirmed add-ons onto the invoice ledger - belt-and-suspenders:
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
                // Add-ons are NOT cleared - they stay on the row (shown with a
                // check once confirmed) so they never vanish. Only the per-visit
                // checklist (arrived/performed/completed) resets for next visit.
                workChecklist: [],
                // Snapshot this session's note into the per-session log, then blank
                // the working note so the next visit starts clean. Prefer the
                // note sent in the request body (the frontend may hold a newer
                // value that hasn't been persisted to the doc yet) and fall
                // back to whatever is already stored.
                note: "",
                $push: {
                    activityLog: logEntry,
                    sessionNotes: {
                        session: sessionsDone,
                        at: new Date().toISOString(),
                        note: (typeof req.body?.note === "string" ? req.body.note : "") || existing.note || "",
                        therapist: existing.doctor ?? "",
                        by: actorName,
                    },
                },
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

        // Mirror the session note into the customer's cross-visit history so it
        // appears in "Therapist Notes (Customer History)" on the appointment panel.
        // Only push when there is actually a note to record. Non-fatal: completion
        // must never fail just because the customer-note write failed.
        const sessionNote = (typeof req.body?.note === "string" ? req.body.note : "") || existing.note || "";
        if (sessionNote.trim() && existing.phonenumber) {
            try {
                await Customer.findOneAndUpdate(
                    {
                        phone: existing.phonenumber,
                        name: { $regex: new RegExp("^" + (existing.name ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") },
                    },
                    {
                        $push: {
                            notes: {
                                at: new Date().toISOString(),
                                by: actorName,
                                userId: String((req.user as any)?.id ?? (req.user as any)?._id ?? ""),
                                note: sessionNote.trim(),
                            },
                        },
                    },
                ).exec();
            } catch (err) {
                console.error("[completeSession] failed to mirror note to customer record:", err);
            }
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
        const updateData = { ...req.body };

        // Server-managed fields are owned by the visit-OTP + complete-session
        // endpoints and are NEVER settable via a client update. The work checklist
        // echoes the WHOLE draft on every checkbox save, so without this a stale
        // draft silently clobbers them - notably undoing a fresh OTP verification
        // (which then wrongly blocked checkout).
        delete (updateData as any).visitOtpHash;
        delete (updateData as any).visitOtpExpiresAt;
        delete (updateData as any).visitOtpVerified;
        delete (updateData as any).addonOtpHash;
        delete (updateData as any).addonOtpExpiresAt;
        delete (updateData as any).addonOtpTarget;
        delete (updateData as any).sessionNotes;

        const current = await AppointmentBooking.findById(id).exec();
        if (!current) {
            return res.status(404).send({
                success: false,
                message: "Appointment not found",
            });
        }
        const cur = current as any;

        // ── Actor: from the verified JWT (userAuth), never the client body. ──
        // Login stores user.id = User._id, and reachedOutBy.userId is set to that
        // same id on the frontend - so this ownership comparison is sound.
        const user = req.user as any;
        const actorId = String(user?._id ?? user?.id ?? "");
        const actorName = user?.userfName
            ? `${user.userfName ?? ""} ${user.userlName ?? ""}`.trim()
            : (user?.userEmail ?? "someone");
        const isAdmin = user?.role === "SUPER_ADMIN" || user?.role === "ADMIN";

        // ── Executive-lock (T3/T4/T5): ownership-aware edits + authoritative audit. ──
        const ownerId = cur.reachedOutBy?.userId ?? "";
        const ownerName = cur.reachedOutBy?.name ?? "another executive";
        const isOwner = !!ownerId && !!actorId && ownerId === actorId;
        const nonOwnerExec = !!ownerId && !isOwner && !isAdmin;

        // Reason travels in overrideReason (T3/T5) / reassignReason (T4) - not columns.
        const reason = String(
            req.body.overrideReason ?? req.body.reassignReason ?? "",
        ).trim();
        delete updateData.overrideReason;
        delete updateData.reassignReason;

        const changingTherapist =
            updateData.doctorId !== undefined &&
            (updateData.doctorId ?? "") !== (cur.doctorId ?? "");
        const reassigningTherapist = changingTherapist && !!cur.doctorId;
        // Only changing FROM an existing owner TO a different one is gated -
        // claiming an unclaimed lead stays free.
        const newOwnerId = updateData.reachedOutBy?.userId ?? "";
        const changingOwner = !!ownerId && !!newOwnerId && newOwnerId !== ownerId;

        if (changingOwner && !isAdmin) {
            return res.status(403).send({
                success: false,
                message: "Only an admin can reassign the lead owner.",
            });
        }
        if (nonOwnerExec && !reason) {
            return res.status(400).send({
                success: false,
                message: `This lead is owned by ${ownerName}. Add a reason to edit it.`,
            });
        }
        if (reassigningTherapist && !isAdmin && !reason) {
            return res.status(400).send({
                success: false,
                message: "Reassigning the therapist needs a reason.",
            });
        }

        // ── Pay-before-therapist gate (a money rule, not a permission). A
        // therapist may not be assigned to an unpaid booking. The drawer disables
        // the control, but that is only a courtesy - enforce it server-side so a
        // direct API call or a UI slip can't skip payment. Applies to everyone;
        // an exception just means recording the payment first. (report §3.1) ──
        const assigningTherapist =
            changingTherapist && (updateData.doctorId ?? "") !== "";
        const willBePaid =
            updateData.paymentReceived ?? cur.paymentReceived ?? false;
        if (assigningTherapist && !willBePaid) {
            return res.status(400).send({
                success: false,
                message: "Record the payment before assigning a therapist.",
            });
        }

        // ── Server-stamped audit entries (actor from the JWT, not the client). ──
        const now = new Date().toISOString();
        const entries: { at: string; userId: string; name: string; action: string }[] = [];
        if (nonOwnerExec) {
            entries.push({
                at: now, userId: actorId, name: actorName,
                action: `Edited ${ownerName}'s lead - reason: ${reason}`,
            });
        }
        if (reassigningTherapist) {
            entries.push({
                at: now, userId: actorId, name: actorName,
                action: `Therapist reassigned (${cur.doctorId} → ${updateData.doctorId})${reason ? ` - reason: ${reason}` : ""}`,
            });
        }
        if (reason && !updateData.statusNote) updateData.statusNote = reason;
        if (entries.length) {
            const base = Array.isArray(updateData.activityLog)
                ? updateData.activityLog
                : (cur.activityLog ?? []);
            updateData.activityLog = [...base, ...entries];
        }

        const updated = await AppointmentBooking.findByIdAndUpdate(id, updateData, {
            new: true,
        }).exec();
        if (!updated) {
            return res.status(404).send({
                success: false,
                message: "Appointment not found",
            });
        }

        // Auto-generate / sync invoice (session completed, consult booked, etc.).
        const actor = {
            name: user?.userfName
                ? `${user.userfName ?? ""} ${user.userlName ?? ""}`.trim()
                : undefined,
            email: user?.userEmail,
        };
        await safeSyncInvoiceFromAppointment({ appointment: updated, actor });

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

// ── Rate limiting for the public (NO auth) endpoints ──────────────────────────
// Buckets are keyed "<scope>:<ip>" so endpoints never share a budget: a customer
// loading their payment page must not be able to lock a different person out of
// the booking form, or vice versa.
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;

// Writes: a real person fills this form once. Tight, to blunt spam.
const ENQUIRY_LIMIT_PER_MINUTE = 5;
// Reads: idempotent, no side effects, and already guarded by a 2^128 token -
// the limit here is only anti-hammering. It must be generous: Indian mobile
// carriers run CGNAT, so MANY paying customers share one public IP and a tight
// limit would have them 429 each other out of paying.
const PAY_LOOKUP_LIMIT_PER_MINUTE = 60;

function tooManyRequests(key: string, limit: number): boolean {
    const now = Date.now();
    const bucket = rateLimitBuckets.get(key);
    if (!bucket || bucket.resetAt < now) {
        rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return false;
    }
    bucket.count++;
    return bucket.count > limit;
}

function clientIp(req: Request): string {
    return (
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
        req.socket.remoteAddress ||
        "unknown"
    );
}

// ── Public booking endpoint (NO auth) ─────────────────────────────────────────
// Used by the public mdw patient site's booking form.

export const addPublicEnquiry = async (req: Request, res: Response) => {
    try {
        if (tooManyRequests(`enquiry:${clientIp(req)}`, ENQUIRY_LIMIT_PER_MINUTE)) {
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

        // Same createBooking() service the dashboard uses - so a public lead now
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
                    "Thanks! We already have your enquiry - our team will reach out, and we've noted your latest details.",
                data: {
                    enquiryId: result.appointment.enquiryId,
                    repeatCount: result.repeatCount,
                },
            });
        }

        return res.status(201).send({
            success: true,
            message: "Booking received - our team will reach out shortly.",
            data: { enquiryId: result.appointment.enquiryId },
        });
    } catch (error: any) {
        console.error("[addPublicEnquiry]", error);
        return res.status(500).send({
            success: false,
            message: "Server error - please try again.",
        });
    }
};

// ── Payment link ──────────────────────────────────────────────────────────────
// Mint the unguessable token behind this booking's public /pay/<token> page.
// The TOKEN IS MINTED SERVER-SIDE ON PURPOSE - never let the client choose it,
// or a buggy/hostile caller could set a predictable one and expose customers.
// Idempotent: re-requesting payment returns the same token, so a link already
// sent to a customer keeps working.
export const createPaymentLink = async (req: Request, res: Response) => {
    try {
        const appointment = await AppointmentBooking.findById(req.params.id);
        if (!appointment) {
            return res
                .status(404)
                .send({ success: false, message: "Booking not found" });
        }

        if (!appointment.payToken) {
            appointment.payToken = crypto.randomBytes(16).toString("hex");
            await appointment.save();
        }

        return res.status(200).send({
            success: true,
            message: "Payment link ready",
            data: { payToken: appointment.payToken },
        });
    } catch (error: any) {
        console.error("[createPaymentLink]", error);
        return res
            .status(500)
            .send({ success: false, message: "Server error - please try again." });
    }
};

// ── Public payment summary (NO auth) ──────────────────────────────────────────
// Backs the customer-facing payment page. Anyone holding the link can read this,
// so it returns ONLY what a customer needs to recognise their own booking and
// pay for it. Never phone, email, age, location, notes, the activity trail, or
// which therapist is coming. Rate-limited like the other public endpoint.
export const getPublicPaymentSummary = async (req: Request, res: Response) => {
    try {
        if (tooManyRequests(`pay:${clientIp(req)}`, PAY_LOOKUP_LIMIT_PER_MINUTE)) {
            return res.status(429).send({
                success: false,
                message: "Too many requests. Please try again in a minute.",
            });
        }

        const token = String(req.params.token ?? "");
        // Tokens are 32 hex chars - anything shorter is a probe, not a typo.
        // Bail before touching the database.
        if (!/^[a-f0-9]{32}$/.test(token)) {
            return res
                .status(404)
                .send({ success: false, message: "Payment link not found" });
        }

        const booking = await AppointmentBooking.findOne({ payToken: token });
        if (!booking) {
            return res
                .status(404)
                .send({ success: false, message: "Payment link not found" });
        }

        const { lines, due } = bookingLedger(booking);
        const items = lines
            .filter((l) => l.state === "due")
            .map((l) => ({ label: l.label, amount: l.amount }));

        return res.status(200).send({
            success: true,
            message: "ok",
            data: {
                enquiryId: booking.enquiryId,
                name: booking.name,
                typeOfappointment: booking.typeOfappointment,
                amount: due,
                items,
                paymentReceived: due <= 0,
            },
        });
    } catch (error: any) {
        console.error("[getPublicPaymentSummary]", error);
        return res
            .status(500)
            .send({ success: false, message: "Server error - please try again." });
    }
};
