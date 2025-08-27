import { Request, Response } from "express";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { Doctor } from "../models/doctorsModel.ts";


export default async function GetAnalytics(req: Request, res: Response) {
    try {
        // Total doctors
        const totalDoctors = await Doctor.countDocuments();

        // Active doctors
        const activeDoctors = await Doctor.countDocuments({ isActive: true });

        // Unique patients (based on unique email in appointments)
        const uniquePatientEmails = await AppointmentBooking.aggregate([
            {
                $group: {
                    _id: "$email",  // Group by email to get unique ones
                },
            },
            {
                $count: "uniquePatients",  // Count the unique email groups
            },
        ]);

        const totalPatients = uniquePatientEmails.length > 0 ? uniquePatientEmails[0].uniquePatients : 0;

        // Total appointments
        const totalAppointments = await AppointmentBooking.countDocuments();

        // Patients and appointments in the current month
        const currentMonth = new Date();
        const startOfMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
        const endOfMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0, 23, 59, 59);

        const patientsInCurrentMonth = await AppointmentBooking.aggregate([
            {
                $match: {
                    slot: {
                        date: { $gte: startOfMonth, $lte: endOfMonth },
                    },
                },
            },
            {
                $group: {
                    _id: "$email",  // Group by email to get unique patients
                },
            },
            {
                $count: "patientsInCurrentMonth",
            },
        ]);

        const appointmentsInCurrentMonth = await AppointmentBooking.countDocuments({
            "slot.date": { $gte: startOfMonth, $lte: endOfMonth },
        });
        const data = {
            totalDoctors,
            activeDoctors,
            totalPatients,
            totalAppointments,
            patientsInCurrentMonth: patientsInCurrentMonth.length > 0 ? patientsInCurrentMonth[0].patientsInCurrentMonth : 0,
            appointmentsInCurrentMonth,
        }
        // console.log(data);        
        return res.status(200).send({
            success: true,
            data: data
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}