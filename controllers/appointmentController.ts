import express from "express";
import type { Request, Response } from "express";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { Doctor } from "../models/doctorsModel.ts";
import { nextSequence } from "../lib/counters.ts";

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
