import express from "express";
import type { Request, Response } from "express";
import { Doctor } from "../models/doctorsModel.ts";
import AppointmentBookingModel from "../models/appointmentsBookingModel.ts";
import User from "../models/userModel.ts";
import { Types } from "mongoose";
import { logger } from "../lib/logger.ts";
import { nextSequence } from "../lib/counters.ts";



export async function addDoctor(req: Request, res: Response) {
  try {

    const details = req.body;
    const { doctorId, name, email, phonenumber, password } = details;

    if (!name || !email || !phonenumber) {
      return res.status(400).send({
        success: false,
        message: "Name, email and phone number are required.",
      });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).send({
        success: false,
        message: "A login password (at least 6 characters) is required.",
      });
    }

    const existingDoctor = await Doctor.findOne({ email }).exec();
    if (existingDoctor) {
      return res.status(400).send({
        success: false,
        message: "A therapist already exists with this email",
      });
    }
    const existingUser = await User.findOne({
      $or: [{ userEmail: email }, { userPhone: String(phonenumber) }],
    }).exec();
    if (existingUser) {
      return res.status(400).send({
        success: false,
        message: "A user already exists with this email or phone number.",
      });
    }

    // 1) Create the login account (role THERAPIST). The model hashes the password.
    const [first, ...rest] = String(name).trim().split(/\s+/);
    const newUser = new User({
      userfName: first || name,
      userlName: rest.join(" ") || "-",
      userEmail: email,
      userPhone: String(phonenumber),
      userPassword: String(password),
      role: "THERAPIST",
    });
    await newUser.save();

    // 2) Create the roster profile, linked to the user, with an auto THR-#### id.
    const finalDoctorId =
      doctorId ||
      `THR-${String(await nextSequence("therapist")).padStart(4, "0")}`;
    try {
      const { password: _pw, ...doctorFields } = details;
      const saveDoctor = new Doctor({
        ...doctorFields,
        doctorId: finalDoctorId,
        userId: newUser._id.toString(),
      });
      await saveDoctor.save();
    } catch (docErr: any) {
      // Roll back the user so we never leave an orphan login.
      await User.findByIdAndDelete(newUser._id).catch(() => {});
      throw docErr;
    }

    logger.info("Therapist created", {
      doctorId: finalDoctorId,
      userId: newUser._id.toString(),
    });
    return res.status(200).send({
      success: true,
      message: "Therapist added (with login)",
    });
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
    const data = Doctor.find().sort({createdAt:-1});
    const doctorsDetails = await data.exec();
    if (!doctorsDetails) {
      return res.status(404).send({
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
      return res.status(404).send({
        success: false,
        message: "Id is required",
      })
    }
    const data = await AppointmentBookingModel.find({ doctorId: id }).exec();

    return res.status(200).send({
      success: true,
      message: "Data retrived",
      data: data
    })

  } catch (error: any) {
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
    const { name, doctorId, phonenumber, email, specialization, bio, isActive, profileImage, certificates } = req.body;
    // console.log(req.body);
    const updatedDoctor = await Doctor.findOneAndUpdate(
      { doctorId: id },
      { name, doctorId, phonenumber, email, specialization, bio, isActive, profileImage, certificates },
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

    const deletedDoctor = await Doctor.findOneAndDelete({ doctorId: id });

    if (!deletedDoctor) {
      return res.status(404).json({ message: "Doctor not found" });
    }

    return res.json({ message: "Doctor deleted successfully" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error deleting doctor", error });
  }
}