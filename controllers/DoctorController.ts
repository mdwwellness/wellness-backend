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
            specialization,
            bio
        } = details
        if (!name || !email || !phonenumber || !specialization || !doctorId) {
           return res.status(400).send({
                success: false,
                message: `Missing fields ${details.filter((item: any) => item === undefined).join(", ")}`
            })
        }

        const existingDoctor = await Doctor.find({ email }).exec();
        if (existingDoctor) {
           return res.status(400).send({
                success: false,
                message: "A doctor already exist with this email"
            })
        }

        const saveDoctor = new Doctor(details);
        saveDoctor.save()
       return res.status(200).send({
            success: true,
            message: "Doctor added successfully"
        })
    } catch (error: any) {
        console.log(error)
       return res.status(500).send({
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
          return  res.status(404).send({
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
       return res.status(500).send({
            success: false,
            message: "something went wrong"
        })
    }
}

export async function getPersonalAppointments(req: Request, res: Response) {
    try {

        const id = req.params.id;
        if (!id) {
        return  res.status(404).send({
                success: false,
                message: "Id is required",
            })
        }
        const data =await AppointmentBookingModel.find({ doctorId: id }).exec();
        
      return  res.status(200).send({
            success: true,
            message: "Data retrived",
            data: data
        })

    } catch (error:any) {
        console.log(error);
       return res.status(500).send({
            success: false,
            message: error.message,
        })
    }
}

export async function updateDoctorDetails(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { name, doctorId, phonenumber, email, specialization, bio } = req.body;
    // console.log(req.body);    
    const updatedDoctor = await Doctor.findOneAndUpdate(
      {doctorId:id},
      { name, doctorId, phonenumber, email, specialization, bio },
      { new: true, runValidators: true }
    );

    if (!updatedDoctor) {
      return res.status(404).json({ message: "Doctor not found" });
    }

   return res.json({ message: "Doctor updated successfully", updatedDoctor });
  } catch (error) {
    console.error(error);
   return res.status(500).json({ message: "Error updating doctor", error });
  }
}

export async function deleteDoctor(req: Request, res: Response) {
  try {
    const { id } = req.params;

    const deletedDoctor = await Doctor.findOneAndDelete({doctorId:id});

    if (!deletedDoctor) {
      return res.status(404).json({ message: "Doctor not found" });
    }

  return  res.json({ message: "Doctor deleted successfully" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error deleting doctor", error });
  }
}