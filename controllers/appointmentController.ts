import express from "express";
import type { Request, Response } from "express";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { Doctor } from "../models/doctorsModel.ts";

// Statuses considered "open" for the duplicate-phone check.
// A new record with the same phone is rejected only if an OPEN record
// already exists; cancelled / completed records don't block re-engagement.
const OPEN_STATUSES = ["enquiry", "scheduled", "ongoing"];

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
        const { role, id, email } = req.query;
        let appointmentdetails;
        if (role === "SUPER_ADMIN") {
            appointmentdetails = await AppointmentBooking.find().sort({ field: 'asc', _id: -1 }).exec();
        } else if (role === "THERAPIST") {
            const isExistingDoctor = await Doctor.findOne({ email }).exec();
            if (isExistingDoctor) {
                const doctorId = isExistingDoctor.doctorId;
                appointmentdetails = await AppointmentBooking.find({ doctorId: doctorId }).sort({ createdAt: -1 });
            }
        } else {
            return res.status(403).json({ message: "Forbidden: Role not allowed" });
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
