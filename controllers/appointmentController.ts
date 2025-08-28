import { Request, Response } from "express"
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { Doctor } from "../models/doctorsModel.ts";


export const addAppointmentsDetails = async (req: Request, res: Response) => {
    const details = req.body
    // console.log(details);
    const {
        name,
        location,
        slot,
        category,
        age,
        phonenumber,
        note
    } = details;

    //check if all fields are present
    if (!name || !location || !slot || !category || !age || !phonenumber) {
        return res.status(400).send({
            success: false,
            message: "Missing required fields.",
        })
    }
    const existingBooking = await AppointmentBooking.findOne({ phonenumber: phonenumber });

    if (existingBooking) {
        return res.status(404).send({
            success: false,
            message: "Already booked and appointment"
        })
    }

    const result = new AppointmentBooking(details)
    result.save()
    return res.status(200).send({
        success: true,
        message: "Appointment booked",
    })
}


export const getAllAppointments = async (req: Request, res: Response) => {
    try {
        const { role, id, email } = req.query;
        let appointmentdetails;
        if (role === "SUPER_ADMIN") {
            appointmentdetails =await AppointmentBooking.find().sort({ field: 'asc', _id: -1 }).exec();
        } else if (role === "DOCTOR") {
            // Doctor can only see his appointments
            const isExistingDoctor = await Doctor.findOne({ email }).exec();
            if (isExistingDoctor) {
                const doctorId = isExistingDoctor.doctorId;
                appointmentdetails = await AppointmentBooking.find({ doctorId: doctorId });
            }
        } else {
            return res.status(403).json({ message: "Forbidden: Role not allowed" });
        }
        // console.log(appointmentdetails);
        return res.status(200).send({
            success: true,
            data: appointmentdetails,
        })
    } catch (error: any) {
        console.error("Error fetching details:", error);
        return res.status(500).send({
            success: false,
            message: error.message
        });
    }
}
export const deleteAppointment = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        // console.log(id);        
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
        // console.log(updateData);        
        const updated = await AppointmentBooking.findByIdAndUpdate(
            id,
            updateData,
        );
        // console.log("updated",updated)
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
