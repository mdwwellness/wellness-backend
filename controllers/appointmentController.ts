import { Request, Response } from "express"
import AppointmentBooking from "../models/appointmentsBookingModel.ts";


export const addAppointmentsDetails = async (req: Request, res: Response) => {
    const details  = req.body
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
        res.send(400).json({
            success: false,
            message: "Missing required fields.",
        })
    }
    const existingBooking = await AppointmentBooking.findOne({ phonenumber: phonenumber });

    if (existingBooking) {
        res.send(404).json({
            success: false,
            message: "Already booked and appointment"
        })
    }

    const result = new AppointmentBooking(details)
    result.save()
    res.send(200).json({
        success: true,
        message: "Appointment booked",
    })
}


export const getAllAppointments = async (req: Request, res: Response) => {
    try {

        const appointmentdetails = AppointmentBooking.find();
        const result = await appointmentdetails.exec()
        res.status(200).send({
            success: true,
            data: result,
        })
    } catch (error: any) {
        console.error("Error fetching details:", error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
}