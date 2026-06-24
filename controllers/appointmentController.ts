import express from "express";
import type { Request, Response } from "express";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { Doctor } from "../models/doctorsModel.ts";
import { nextSequence } from "../lib/counters.ts";
import { logger } from "../lib/logger.ts";

// Statuses considered "open" for the duplicate-phone check.
// A new record with the same phone is rejected only if an OPEN record
// already exists; cancelled / completed records don't block re-engagement.
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
    const details = req.body;
    const { name, phonenumber } = details;

    // Only name and phonenumber are required at the wire level.
    // The rest of the fields are populated as the lead progresses through
    // the funnel (enquiry → consultation booked → physio assignment).
    if (!name || !phonenumber) {
        return res.status(400).send({
            success: false,
            message: "Name and phone number are required.",
        });
    }

    // Status-aware duplicate-phone check.
    // Allow re-engagement when previous records are cancelled or completed.
    const existingBooking = await AppointmentBooking.findOne({
        phonenumber: phonenumber,
        status: { $in: OPEN_STATUSES },
    });

    if (existingBooking) {
        return res.status(409).send({
            success: false,
            message: "An open enquiry/appointment already exists for this phone number.",
        });
    }

    // Allocate the next sequential enquiry ID (ENQ-0001, ENQ-0002, ...).
    // 4-digit zero-padded; expands naturally to 5 digits at 10000.
    const seq = await nextSequence("enquiry");
    const enquiryId = `ENQ-${String(seq).padStart(4, "0")}`;
    details.enquiryId = enquiryId;

    const result = new AppointmentBooking(details);
    await result.save();
    logger.info("Enquiry created (dashboard)", { enquiryId, phonenumber });
    return res.status(200).send({
        success: true,
        message: "Appointment booked",
        data: result,
    });
};


export const getAllAppointments = async (req: Request, res: Response) => {
    try {
        // Trust the server-verified user from JWT (set by userAuth middleware),
        // NOT the client-supplied ?role= query param — that was spoofable and
        // also broke for back-office roles other than SUPER_ADMIN.
        const role = req.user?.role;
        const userEmail = req.user?.userEmail;

        let appointmentdetails: any[] = [];

        if (role && BACK_OFFICE_ROLES.has(role)) {
            // Back-office staff (SUPER_ADMIN, ADMIN, STAFF, CUSTOMER_CARE)
            // see every appointment / enquiry record.
            appointmentdetails = await AppointmentBooking.find()
                .sort({ createdAt: -1 })
                .exec();
        } else if (role === "THERAPIST") {
            // Therapists see only the appointments assigned to them.
            const isExistingDoctor = await Doctor.findOne({ email: userEmail }).exec();
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

export const updateAppointment = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const updateData = req.body;
        const updated = await AppointmentBooking.findByIdAndUpdate(
            id,
            updateData,
        );
        if (!updated) {
            return res.status(404).send({
                success: false,
                message: "Appointment not found",
            });
        }

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

        if (!name || typeof name !== "string" || name.trim().length < 2) {
            return res.status(400).send({
                success: false,
                message: "Name is required (at least 2 characters).",
            });
        }
        if (!phonenumber || typeof phonenumber !== "number") {
            return res.status(400).send({
                success: false,
                message: "Phone number is required (numeric).",
            });
        }

        // Repeat-submission handling. If this number already has an OPEN lead,
        // we DON'T create a duplicate row. Instead we fold the repeat into the
        // existing lead: bump its repeatCount and append the new submission to
        // its activity log so staff can see any corrected details (they
        // reconcile the lead's fields manually).
        const existing = await AppointmentBooking.findOne({
            phonenumber,
            status: { $in: OPEN_STATUSES },
        });
        if (existing) {
            const repeatNumber = (existing.repeatCount ?? 1) + 1;

            const detailBits: string[] = [];
            if (typeOfappointment) detailBits.push(`type: ${typeOfappointment}`);
            if (location) detailBits.push(`location: ${location}`);
            if (preferredReachOutTime?.from || preferredReachOutTime?.to) {
                detailBits.push(
                    `time: ${preferredReachOutTime?.from ?? "?"}–${preferredReachOutTime?.to ?? "?"}`,
                );
            }
            if (note) detailBits.push(`note: ${note}`);
            const action = `Re-submitted via public form (#${repeatNumber})${
                detailBits.length ? " — " + detailBits.join(", ") : ""
            }`;

            existing.repeatCount = repeatNumber;
            existing.activityLog.push({
                at: new Date().toISOString(),
                name: name.trim(),
                action,
            });
            await existing.save();
            logger.info("Public booking repeat folded into existing lead", {
                enquiryId: existing.enquiryId,
                repeatCount: repeatNumber,
            });

            return res.status(200).send({
                success: true,
                message:
                    "Thanks! We already have your enquiry — our team will reach out, and we've noted your latest details.",
                data: { enquiryId: existing.enquiryId, repeatCount: repeatNumber },
            });
        }

        const seq = await nextSequence("enquiry");
        const enquiryId = `ENQ-${String(seq).padStart(4, "0")}`;

        const record = new AppointmentBooking({
            name: name.trim(),
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
            enquiryId,
        });
        await record.save();
        logger.info("Public booking created", {
            enquiryId,
            source: source || "public_booking_form",
        });

        return res.status(201).send({
            success: true,
            message: "Booking received — our team will reach out shortly.",
            data: { enquiryId },
        });
    } catch (error: any) {
        console.error("[addPublicEnquiry]", error);
        return res.status(500).send({
            success: false,
            message: "Server error — please try again.",
        });
    }
};
