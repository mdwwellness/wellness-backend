import express from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { Request, Response } from "express";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import Customer from "../models/customerModel.ts";
import { Doctor } from "../models/doctorsModel.ts";
import { TherapistLeave } from "../models/therapistLeaveModel.ts";
import Service from "../models/serviceModel.ts";
import { nextSequence } from "../lib/counters.ts";
import { logger } from "../lib/logger.ts";
import {
    ensureCustomerForAppointment,
    lockConfirmedAddonsToInvoice,
    maybeCreateInvoiceForAppointment,
    safeSyncInvoiceFromAppointment,
} from "../lib/invoiceGeneration.ts";
import { bookingTimeProblem, createBooking, findTherapistClash } from "../lib/bookingService.ts";
import {
    BOOKING_SOURCES,
    HIDDEN_FROM_THERAPISTS,
    isSourceChange,
    resolveBookingSource,
} from "../lib/bookingSource.ts";
import { payableLedger } from "../lib/bookingMoney.ts";
import { lockedSplitFields } from "../lib/therapistSplit.ts";
import { addonCataloguePrice, applyLockedFields, stripServerOwned } from "../lib/lockedFields.ts";
import { addonSessions, checkAddonSchedule, createAddonVisits } from "../lib/addonVisits.ts";
import { addonKey, courseSessionOf, isAssignedTherapist, mayActOnBooking, moneyRowFor, recordPayment, unpaidBeforeComplete } from "../lib/payments.ts";
import { referrerForCode } from "../lib/referralCode.ts";
import { clientIp, tooManyRequests } from "../lib/rateLimit.ts";
import { birthYearFrom, toAge, toGender } from "../lib/personDetails.ts";
import { withVisitStatus } from "../lib/visitStatus.ts";
import { legacyTick, recordPayout, withPayouts } from "../lib/payouts.ts";

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
        // No pinned source here: staff pick online / whatsapp / walk-in /
        // therapist on the form, and createBooking validates it.
        const result = await createBooking(req.body, { actor });

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


/** "yyyy-MM-dd" of a stored slot date (Date or string), or "". */
const dayKey = (d: unknown): string => {
    const t = d ? new Date(d as string) : null;
    return t && !Number.isNaN(t.getTime()) ? t.toISOString().slice(0, 10) : "";
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
        let viewerDoctorId: string | null = null;

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
                viewerDoctorId = doctorId ?? null;
                appointmentdetails = await AppointmentBooking.find({ doctorId: doctorId })
                    .select(HIDDEN_FROM_THERAPISTS)
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
            // Each with its list status, the same for every viewer (lib/visitStatus.ts),
            // and what it earns (lib/payouts.ts).
            data: await withPayouts(await withVisitStatus(appointmentdetails), { role, doctorId: viewerDoctorId }),
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
        const { serviceId, category, sessions, slot, durationMin, intervalDays, applyDiscount } = req.body ?? {};

        if (!serviceId || typeof serviceId !== "string") {
            return res.status(400).send({
                success: false,
                message: "serviceId is required.",
            });
        }
        // One number, used for the price, the schedule and what's stored alike.
        if (sessions !== undefined && !(Number.isInteger(sessions) && sessions >= 1)) {
            return res.status(400).send({ success: false, message: "Sessions must be a whole number." });
        }

        const appointment = await AppointmentBooking.findById(id).exec();
        if (!appointment) {
            return res.status(404).send({
                success: false,
                message: "Appointment not found",
            });
        }
        if (!(await mayActOnBooking(req.user as any, appointment))) {
            return res.status(403).send({ success: false, message: "This visit isn't assigned to you." });
        }

        if (appointment.appointmentKind === "recommended") {
            return res.status(400).send({
                success: false,
                message:
                    "Cannot add recommendations to a legacy recommended row. Open the parent appointment instead.",
            });
        }

        // Priced from the catalogue, never the client (ISSUES #58); the discount
        // is the therapist's call, on unless they untick it.
        const priced = await addonCataloguePrice(serviceId, sessions, applyDiscount !== false);
        if (!priced) {
            return res.status(404).send({ success: false, message: "That service isn't in the catalogue." });
        }
        if (!(priced.price > 0)) {
            return res.status(400).send({ success: false, message: `${priced.name} has no price for ${Number(sessions) > 1 ? `${sessions} sessions` : "one session"} yet.` });
        }
        const { name: serviceName, price: quotedPrice } = priced;

        // When it will be done, always by this booking's therapist; no clashes.
        const schedule = await checkAddonSchedule(appointment, {
            slot,
            durationMin,
            intervalDays,
            sessions: typeof sessions === "number" ? sessions : undefined,
        });
        if (!schedule.ok) {
            return res.status(schedule.code).send({ success: false, message: schedule.message });
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
            ...schedule.fields,
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
        if (!(await mayActOnBooking(req.user as any, appt))) {
            return res.status(403).send({ success: false, message: "This visit isn't assigned to you." });
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
        if (!(await mayActOnBooking(req.user as any, appointment))) {
            return res.status(403).send({ success: false, message: "This visit isn't assigned to you." });
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
                    // Done in this visit only if it's still open now. Once it's
                    // finished, createAddonVisits gives the first session its own
                    // visit, so the visit itself must not count it too.
                    ...(recs[idx].slot?.date ? { [`${path}.firstInVisit`]: addonSessions(recs[idx], appointment)[0].inVisit } : {}),
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
        // Sessions on another day become their own visits (same therapist).
        const visits = updated ? await createAddonVisits(updated, updated.recommendedServices[idx], actorName) : [];
        if (updated) {
            await safeSyncInvoiceFromAppointment({ appointment: updated, actor });
        }

        return res.status(200).send({
            success: true,
            message: visits.length
                ? `Add-on confirmed - ${visits.length} visit${visits.length === 1 ? "" : "s"} scheduled`
                : "Add-on confirmed for this visit",
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

const VISIT_OTP_MAX_ATTEMPTS = 5;

/** "2026-10-15 11:05" in India time, for activity-log text. */
const stamp = (d: Date) =>
  new Date(d).toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" }).slice(0, 16);

export const sendVisitOtp = async (req: Request, res: Response) => {
  try {
    const appt = await AppointmentBooking.findById(req.params.id).exec();
    if (!appt) {
      return res.status(404).send({ success: false, message: "Appointment not found" });
    }
    // Crypto-random 4-digit code (not Math.random).
    const code = String(crypto.randomInt(1000, 10000));
    // No expiry: the code works until it's used (or a new one replaces it).
    appt.visitOtpHash = await bcrypt.hash(code, 10);
    appt.visitOtpVerified = false;
    appt.visitOtpAttempts = 0;
    appt.visitOtpSentAt = new Date();
    const user = req.user as any;
    appt.visitOtpSentBy = user?.userfName
      ? `${user.userfName ?? ""} ${user.userlName ?? ""}`.trim()
      : (user?.userEmail ?? "");
    appt.visitOtpVerifiedAt = undefined;
    await appt.save();
    // Code returned so the exec can send it via wa.me (manual interim channel).
    // Only office roles reach this (see the route), never the therapist.
    return res.status(200).send({ success: true, code });
  } catch (error: any) {
    console.error("[sendVisitOtp]", error);
    return res.status(500).send({ success: false, message: "Server error" });
  }
};

/**
 * Record money received (part or full). Office roles on any booking; the
 * assigned therapist on their own visit (cash at the door). Never more than due.
 */
export const addPayment = async (req: Request, res: Response) => {
  try {
    const row = await AppointmentBooking.findById(req.params.id).exec();
    if (!row) {
      return res.status(404).send({ success: false, message: "Appointment not found" });
    }
    const user = req.user as any;
    if (user?.role === "THERAPIST" && !(await isAssignedTherapist(user, row))) {
      return res.status(403).send({ success: false, message: "This visit isn't assigned to you." });
    }
    const result = await recordPayment({ row, amount: req.body?.amount, method: req.body?.method, user, addon: req.body?.addon });
    if (!result.ok) {
      return res.status(result.code).send({ success: false, message: result.message });
    }
    await safeSyncInvoiceFromAppointment({
      appointment: result.booking,
      actor: { name: result.booking.payments?.at(-1)?.by, email: user?.userEmail },
    });
    return res.status(200).send({ success: true, message: "Payment recorded", data: result.booking });
  } catch (error: any) {
    console.error("[addPayment]", error);
    return res.status(500).send({ success: false, message: "Server error" });
  }
};

/** Mark a therapist's payout on a booking paid, or undo it (Admin / Super Admin, see the route). */
export const addPayout = async (req: Request, res: Response) => {
  try {
    const row = await AppointmentBooking.findById(req.params.id).exec();
    if (!row) return res.status(404).send({ success: false, message: "Appointment not found" });
    const result = await recordPayout({ row, doctorId: req.body?.doctorId, paid: req.body?.paid, user: req.user as any });
    if (!result.ok) return res.status(result.code).send({ success: false, message: result.message });
    return res.status(200).send({ success: true, message: req.body?.paid === true ? "Payout recorded" : "Payout undone" });
  } catch (error: any) {
    console.error("[addPayout]", error);
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
    if (!appt.visitOtpHash) {
      return res.status(400).send({ success: false, message: "No code yet - ask the office to send one." });
    }

    // Only the therapist assigned to this booking can start its session.
    if (!(await isAssignedTherapist(req.user as any, appt))) {
      return res.status(403).send({ success: false, message: "This visit isn't assigned to you." });
    }

    // Payment is NOT checked here any more. A therapist can start the session
    // as soon as the customer's OTP verifies. The visit's payment is enforced at
    // completion instead - see completeSession -> unpaidBeforeComplete (402).

    // Use up one of the code's attempts atomically before checking it, so
    // parallel guesses can't get past the limit.
    const reserved = await AppointmentBooking.findOneAndUpdate(
      { _id: appt._id, visitOtpAttempts: { $not: { $gte: VISIT_OTP_MAX_ATTEMPTS } } },
      { $inc: { visitOtpAttempts: 1 } },
    ).exec();
    if (!reserved) {
      return res.status(429).send({ success: false, message: "Too many wrong codes - ask the office to send a new one." });
    }

    const ok = await bcrypt.compare(String(code ?? "").trim(), appt.visitOtpHash);
    if (!ok) {
      return res.status(400).send({ success: false, message: "Incorrect code." });
    }
    appt.visitOtpVerified = true;
    appt.visitOtpVerifiedAt = new Date();
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
        if (!(await mayActOnBooking(req.user as any, existing))) {
            return res.status(403).send({ success: false, message: "This visit isn't assigned to you." });
        }

        // Per-visit proof-of-presence: no checkout until this visit's OTP is
        // verified. Consumed below on success, so every session needs a fresh one.
        if (!existing.visitOtpVerified) {
            return res.status(400).send({
                success: false,
                message: "Verify the visit OTP before checkout.",
            });
        }

        // A therapist finishes only once the work is recorded: Service performed
        // ticked and a session note written. The tick can arrive with this
        // request (it may still be saving). The office's "Complete anyway" on
        // their behalf is the recorded override.
        // Never falls back to `note`: that's the customer's enquiry note, not the
        // therapist's (it used to get filed as the session note).
        const sessionNote =
            (typeof req.body?.note === "string" ? req.body.note : "") || existing.sessionNoteDraft || "";
        const performed =
            req.body?.performed === true || (existing.workChecklist ?? []).includes("performed");
        if ((req.user as any)?.role === "THERAPIST" && (!performed || !sessionNote.trim())) {
            return res.status(400).send({
                success: false,
                message: "Tick Service performed and write the session note first.",
            });
        }

        // Everything this visit owes is collected before it closes - a single
        // or last visit has no later visit to collect it on.
        const unpaid = unpaidBeforeComplete(existing, await moneyRowFor(existing));
        if (unpaid.amount > 0) {
            return res.status(402).send({
                success: false,
                message: `Collect ₹${unpaid.amount}${unpaid.addons.length ? ` (incl. ${unpaid.addons.join(", ")})` : ""} before completing this visit - record it in Billing.`,
                short: unpaid.amount,
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
        // An add-on visit, or one session of a course with a visit per session,
        // completes exactly once - it never moves on to the next session (that
        // has its own visit). Only a one-booking package counts sessions here.
        const ownSession = courseSessionOf(existing);
        const total = existing.addonOf?.bookingId || ownSession
            ? 1
            : service?.packageCount ?? existing.totalSessions ?? 1;
        const sessionLabel = ownSession
            ? `Session ${ownSession.session} of ${ownSession.total}`
            : existing.addonOf?.bookingId
                ? `${existing.service ?? "Add-on"} session ${existing.addonOf.session}`
                : null;

        // Lock the therapist's split in at the first completed session, so a
        // later change to their % never rewrites this booking's earnings.
        const splitLock = await lockedSplitFields(
            existing.therapistSplitPercent,
            existing.doctorId,
        );

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
                $set: { visitOtpVerified: false, visitOtpHash: null, visitOtpExpiresAt: null, visitOtpSentAt: null, visitOtpSentBy: null, visitOtpVerifiedAt: null, ...splitLock },
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
        const sessionNo = ownSession?.session ?? existing.addonOf?.session ?? sessionsDone;
        const done = sessionsDone >= total;

        const actorName = (req.user as any)?.userfName
            ? `${(req.user as any).userfName ?? ""} ${(req.user as any).userlName ?? ""}`.trim()
            : (req.user as any)?.userEmail ?? "Therapist";

        const logEntry = {
            at: new Date().toISOString(),
            userId: String((req.user as any)?.id ?? (req.user as any)?._id ?? ""),
            name: actorName,
            action:
                (sessionLabel
                    ? `${sessionLabel} completed`
                    : done
                        ? `Package complete - all ${total} sessions done`
                        : `Session ${sessionsDone} of ${total} completed - schedule next visit`) +
                ((req.user as any)?.role !== "THERAPIST" ? " (completed by an admin on the therapist's behalf)" : "") +
                // Keep this visit's code times once the fields reset for the next visit.
                (existing.visitOtpSentAt
                    ? ` - code sent ${stamp(existing.visitOtpSentAt)}${existing.visitOtpSentBy ? ` by ${existing.visitOtpSentBy}` : ""}`
                    : "") +
                (existing.visitOtpVerifiedAt ? `, verified ${stamp(existing.visitOtpVerifiedAt)}` : ""),
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
                // the draft so the next visit starts clean. The customer's `note`
                // is left alone.
                sessionNoteDraft: "",
                $push: {
                    activityLog: logEntry,
                    sessionNotes: {
                        session: sessionNo,
                        at: new Date().toISOString(),
                        note: sessionNote,
                        therapist: existing.doctor ?? "",
                        doctorId: existing.doctorId ?? "",
                        splitPercent: existing.therapistSplitPercent ?? splitLock.therapistSplitPercent ?? null,
                        by: actorName,
                        performed,
                        verifiedAt: existing.visitOtpVerifiedAt ?? undefined,
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
                                // A copy of this session's note, so a therapist sees the
                                // customer's history across other therapists' bookings.
                                kind: "session",
                                enquiryId: existing.enquiryId,
                                session: sessionNo,
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
            message: sessionLabel
                ? `${sessionLabel} completed`
                : done
                    ? total > 1 ? "Package complete" : "Visit completed"
                    : `Session ${sessionsDone} of ${total} completed`,
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

        // A Mongo operator ($set, $inc...) or a dotted path would carry any field
        // past every check below (ISSUES #48). The dashboard sends neither.
        if (Object.keys(updateData).some((k) => k.startsWith("$") || k.includes("."))) {
            return res.status(400).send({ success: false, message: "Invalid update." });
        }

        // Server-owned fields (OTPs, money, the split and payouts, offers, session
        // progress, visit links) are never settable here. The work checklist
        // echoes the WHOLE draft on every checkbox save, so without this a stale
        // draft would also clobber them.
        stripServerOwned(updateData);
        // Set when the booking is made: add-ons have their own endpoints, and a
        // booking's shape (course length, which session this is) never changes
        // by hand, or a visit could be pointed at another booking's money.
        for (const f of ["recommendedServices", "bookingKind", "totalSessions", "sessionNumber", "sessionIntervalDays", "sessionsPerWeek"]) {
            delete (updateData as any)[f];
        }
        // Gender is one of a fixed few, and the update below skips schema checks.
        const gender = toGender(updateData.gender);
        if (gender) updateData.gender = gender;
        else delete updateData.gender;

        const current = await AppointmentBooking.findById(id).exec();
        if (!current) {
            return res.status(404).send({
                success: false,
                message: "Appointment not found",
            });
        }
        if (!(await mayActOnBooking(req.user as any, current))) {
            return res.status(403).send({ success: false, message: "This visit isn't assigned to you." });
        }
        const cur = current as any;

        // History is append-only: keep every stored entry and add only the new
        // ones sent (clients echo the whole log), so a PUT can't rewrite it.
        if (Array.isArray(updateData.activityLog)) {
            const stored = cur.activityLog ?? [];
            const key = (e: any) => `${e?.at}|${e?.action}`;
            const seen = new Set(stored.map(key));
            updateData.activityLog = [...stored, ...updateData.activityLog.filter((e: any) => !seen.has(key(e)))];
        } else {
            delete updateData.activityLog;
        }

        // Customer details and the intake price can't be edited by hand.
        try {
            await applyLockedFields(updateData, cur, req.user?.role);
        } catch (e: any) {
            if (e?.status !== 400) throw e;
            return res.status(400).send({ success: false, message: e.message });
        }

        // ── Booking source: act only on a genuine change (see isSourceChange -
        // whole-record PUTs echo the stored value, including legacy ones).
        if (isSourceChange(updateData, cur)) {
            const resolved = await resolveBookingSource({
                // An echoed legacy value (e.g. only the referrer changed on an
                // old booking) falls back to what's stored.
                source: BOOKING_SOURCES.includes(updateData.source)
                    ? updateData.source
                    : cur.source,
                referredByDoctorId:
                    updateData.referredByDoctorId ?? cur.referredByDoctorId,
            });
            if (!resolved.ok) {
                return res
                    .status(resolved.code)
                    .send({ success: false, message: resolved.message });
            }
            Object.assign(updateData, resolved.fields);
        } else {
            // Unchanged: keep what's stored, and never let a client-sent
            // referredByName overwrite the server-resolved one.
            delete updateData.source;
            delete updateData.referredByDoctorId;
            delete updateData.referredByName;
        }

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
        // The lead lock is between office executives. A therapist saving their
        // visit (arrived, checklist, notes) never needs the owner's say-so.
        const nonOwnerExec =
            !!ownerId && !isOwner && !isAdmin && user?.role !== "THERAPIST";

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
        // A finished visit was done by its therapist, and earns for them (#56).
        if (changingTherapist && cur.status === "completed") {
            return res.status(400).send({
                success: false,
                message: "This visit is done, so its therapist can't be changed.",
            });
        }
        // The next session locks in the new therapist's split, not the old one's.
        // Sessions already done stay with whoever did them: notes from before
        // they were stamped get the old therapist now, and an older "paid" tick
        // moves into the payout ledger under them (lib/payouts.ts).
        if (changingTherapist) {
            updateData.therapistSplitPercent = null;
            const notes = (cur.sessionNotes ?? []).map((s: any) => (typeof s?.toObject === "function" ? s.toObject() : s));
            if (notes.some((s: any) => !s.doctorId)) {
                updateData.sessionNotes = notes.map((s: any) =>
                    s.doctorId ? s : { ...s, doctorId: cur.doctorId ?? "", splitPercent: cur.therapistSplitPercent ?? undefined });
            }
            const oldSplit = cur.doctorId
                ? (await Doctor.findOne({ doctorId: cur.doctorId }, { splitPercent: 1 }).lean() as any)?.splitPercent
                : undefined;
            const tick = legacyTick(cur, oldSplit);
            if (tick && tick.amount > 0) updateData.therapistPayouts = [{ ...tick, at: cur.therapistPaidAt ?? new Date(), by: "" }];
        }

        // A therapist can be assigned before any payment; money is collected
        // per session instead (see verifyVisitOtp and lib/payments.ts).
        const assigningTherapist =
            changingTherapist && (updateData.doctorId ?? "") !== "";

        // ── Therapist availability gate: block assignments on off-days ──
        if (assigningTherapist) {
            const targetDate =
                updateData.slot?.date ||
                updateData.physioSlot?.date ||
                cur.slot?.date ||
                cur.physioSlot?.date;
            if (targetDate) {
                const dayOfWeek = new Date(targetDate + "T00:00:00").getDay();
                const therapist = await Doctor.findOne({
                    doctorId: updateData.doctorId,
                }).lean();
                if (therapist?.weekOffDays?.includes(dayOfWeek)) {
                    const dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
                    return res.status(400).send({
                        success: false,
                        message: `${therapist.name ?? "Therapist"} is off on ${dayNames[dayOfWeek]}s. Pick a different date or therapist.`,
                    });
                }

                // Check one-off leave blocks
                const leaveBlock = await TherapistLeave.findOne({
                    doctorId: updateData.doctorId,
                    startDate: { $lte: targetDate },
                    endDate: { $gte: targetDate },
                }).lean();
                if (leaveBlock) {
                    return res.status(400).send({
                        success: false,
                        message: `${therapist?.name ?? "Therapist"} is on leave from ${leaveBlock.startDate} to ${leaveBlock.endDate}${leaveBlock.reason ? ` (${leaveBlock.reason})` : ""}. Pick a different date or therapist.`,
                    });
                }
            }
        }

        // ── Clash gate: a new therapist, day or time must be free, with the
        // booking gap either side (client rule, no override). Only a real move
        // is checked: whole-record PUTs echo the stored slot.
        const after = { ...cur, ...updateData };
        const spanOf = (v: any) => [
            v.doctorId ?? "",
            dayKey(v.slot?.date),
            v.therapyStartTime || v.physioSlot?.time || v.slot?.time || "",
            v.therapyEndTime ?? "",
        ];
        const [doctorId, date, start, end] = spanOf(after);
        const moving = spanOf(after).join("|") !== spanOf(cur).join("|");
        if (moving && date && start && after.status !== "cancelled") {
            const timeProblem = bookingTimeProblem(date, start, end);
            if (timeProblem) return res.status(400).send({ success: false, message: timeProblem });
        }
        if (moving && doctorId && date && start && after.status !== "cancelled") {
            const clash = await findTherapistClash({ doctorId, date, start, end, excludeId: cur._id });
            if (clash) {
                return res.status(409).send({
                    success: false,
                    message: `${after.doctor ?? "That therapist"} ${clash}.`,
                });
            }
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
        // Marked completed by hand (not via checkout): lock the split in too.
        if (updateData.status === "completed" && cur.status !== "completed") {
            Object.assign(
                updateData,
                await lockedSplitFields(
                    cur.therapistSplitPercent,
                    updateData.doctorId ?? cur.doctorId,
                ),
            );
        }

        if (reason && !updateData.statusNote) updateData.statusNote = reason;
        if (entries.length) {
            updateData.activityLog = [...(updateData.activityLog ?? cur.activityLog ?? []), ...entries];
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
        // An office correction of gender or age is about the person, so it also
        // updates the customer record (bookings alone only fill its blanks).
        // Only a genuine change counts: whole-record PUTs echo stored values.
        if (user?.role !== "THERAPIST" && cur.customer_id) {
            const person: Record<string, unknown> = {};
            if (gender && gender !== cur.gender) person.gender = gender;
            const age = toAge(updateData.age);
            if (age && age !== cur.age) person.birthYear = birthYearFrom(age);
            if (Object.keys(person).length) {
                await Customer.updateOne({ customer_id: cur.customer_id }, { $set: person });
            }
        }

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

// ── Rate limits for the public (NO auth) endpoints (see lib/rateLimit.ts) ─────
// Writes: a real person fills this form once. Tight, to blunt spam.
const ENQUIRY_LIMIT_PER_MINUTE = 5;
// Reads: idempotent, no side effects, and already guarded by a 2^128 token -
// the limit here is only anti-hammering. It must be generous: Indian mobile
// carriers run CGNAT, so MANY paying customers share one public IP and a tight
// limit would have them 429 each other out of paying.
const PAY_LOOKUP_LIMIT_PER_MINUTE = 60;

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
            service,
            vitals,
            age,
            gender,
        } = req.body;

        const input = {
            name,
            phonenumber,
            email: email || undefined,
            location: location || undefined,
            typeOfappointment: typeOfappointment || undefined,
            preferredReachOutTime: preferredReachOutTime || undefined,
            note: note || undefined,
            service: service || undefined,
            vitals: Array.isArray(vitals) && vitals.length ? vitals : undefined,
            // Junk or "Prefer not to say" is simply not stored.
            age: toAge(age),
            gender: toGender(gender),
            status: "enquiry",
        };

        // Same createBooking() service the dashboard uses - so a public lead now
        // gets the SAME customer linkage + invoice handling + guards. Repeat
        // folding stays on for the public form. A website booking is "online",
        // whatever `source` the client sends, unless it carries a therapist's
        // valid referral code; an unknown code is ignored, never an error.
        const referrer = await referrerForCode(req.body?.referralCode);
        const result = await createBooking(
            referrer ? { ...input, referredByDoctorId: referrer } : input,
            { source: referrer ? "therapist" : "online", foldOpenRepeats: true },
        );

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
        if (!(await mayActOnBooking(req.user as any, appointment))) {
            return res.status(403).send({ success: false, message: "This visit isn't assigned to you." });
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

        const { lines, due } = payableLedger(booking);
        const items = lines
            .filter((l) => l.state === "due")
            // What's still owed on each line, not its full price.
            .map((l) => ({ label: l.label, amount: l.due }));

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

// ── Therapist session counts ──────────────────────────────────────────────────
// Returns completed session counts per therapist for the All Therapists table.
// Aggregates from appointments where status = "completed" or sessionsCompleted > 0.
export const getTherapistSessionCounts = async (req: Request, res: Response) => {
    try {
        const result = await AppointmentBooking.aggregate([
            {
                $match: {
                    doctorId: { $exists: true, $ne: null },
                    $and: [
                        { doctorId: { $ne: "" } },
                    ],
                    $or: [
                        { status: "completed" },
                        { sessionsCompleted: { $gt: 0 } },
                    ],
                },
            },
            {
                $group: {
                    _id: "$doctorId",
                    totalSessions: { $sum: "$sessionsCompleted" },
                    completedBookings: { $sum: 1 },
                },
            },
            {
                $project: {
                    _id: 0,
                    doctorId: "$_id",
                    totalSessions: 1,
                    completedBookings: 1,
                },
            },
        ]);

        return res.status(200).send({
            success: true,
            message: "ok",
            data: result,
        });
    } catch (error: any) {
        console.error("[getTherapistSessionCounts]", error);
        return res
            .status(500)
            .send({ success: false, message: "Server error - please try again." });
    }
};
