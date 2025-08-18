import { Request, Response } from "express";
import { Doctor } from "../models/doctorsModel.ts";
import AppointmentBookingModel from "../models/appointmentsBookingModel.ts";
import { Types } from "mongoose";



export async function addDoctor(req: Request, res: Response) {
    try {

        const details = req.body;
        const {
            doctorId,
            name,
            email,
            phonenumber,
            password,
            specialization,
            bio
        } = details
        if (!name || !email || !phonenumber || !password || !specialization || !doctorId) {
            res.status(400).send({
                success: false,
                message: `Missing fields ${details.filter((item: any) => item === undefined).join(", ")}`
            })
        }

        const existingDoctor = await Doctor.find({ email }).exec();
        if (existingDoctor) {
            res.status(400).send({
                success: false,
                message: "A doctor already exist with this email"
            })
        }

        const saveDoctor = new Doctor(details);
        saveDoctor.save()
        res.status(200).send({
            success: true,
            message: "Doctor added successfully"
        })
    } catch (error: any) {
        console.log(error)
        res.status(500).send({
            success: false,
            message: error.message
        })
    }
}

export async function getDoctors(req: Request, res: Response) {
    try {
        const data = Doctor.find();
        const doctorsDetails = await data.exec();

        if (!doctorsDetails) {
            res.status(404).send({
                success: false,
                message: "something went wrong"
            })
        }

        res.status(200).send({
            success: true,
            data: doctorsDetails
        })
    } catch (error: any) {
        console.log(error)
        res.status(500).send({
            success: false,
            message: "something went wrong"
        })
    }
}

export async function getPersonalAppointments(req: Request, res: Response) {
    try {

        const id = req.params.id;
        if (!id) {
            res.status(404).send({
                success: false,
                message: "Id is required",
            })
        }
        const data =await AppointmentBookingModel.find({ doctorId: id }).exec();
        
        res.status(200).send({
            success: true,
            message: "Data retrived",
            data: data
        })

    } catch (error:any) {
        console.log(error);
        res.status(500).send({
            success: false,
            message: error.message,
        })
    }
}