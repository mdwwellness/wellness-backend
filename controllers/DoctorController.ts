import express from "express";
import type { Request, Response } from "express";
import { Doctor } from "../models/doctorsModel.ts";
import AppointmentBookingModel from "../models/appointmentsBookingModel.ts";
import User from "../models/userModel.ts";
import { TherapistLeave } from "../models/therapistLeaveModel.ts";
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

export async function getDoctorByUserId(req: Request, res: Response) {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).send({
        success: false,
        message: "userId is required",
      });
    }
    const doctor = await Doctor.findOne({ userId }).exec();
    if (!doctor) {
      return res.status(404).send({
        success: false,
        message: "Therapist profile not found for this user",
      });
    }
    res.status(200).send({
      success: true,
      data: doctor,
    });
  } catch (error: any) {
    console.log(error);
    return res.status(500).send({
      success: false,
      message: error.message,
    });
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
    const { name, doctorId, phonenumber, email, specialization, bio, isActive, profileImage, certificates, weekOffDays } = req.body;
    // console.log(req.body);
    const updatedDoctor = await Doctor.findOneAndUpdate(
      { doctorId: id },
      { name, doctorId, phonenumber, email, specialization, bio, isActive, profileImage, certificates, weekOffDays },
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

/**
 * Super-admin-only: update any therapist's details.
 * - Updates the Doctor document (name, email, phone, specialization, etc.)
 * - Also updates the linked User login document (userEmail, userPhone, name)
 * - Validates unique constraints before updating email/phone
 * - Returns verification that both Doctor and User were updated
 */
export async function updateTherapistSuperAdmin(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { name, firstName, lastName, phonenumber, email, specialization, bio, isActive, profileImage, certificates, weekOffDays } = req.body;

    // 1️⃣ Find the Doctor first to get userId
    const doctor = await Doctor.findOne({ doctorId: id }).exec();
    if (!doctor) {
      return res.status(404).json({ message: "Therapist not found" });
    }

    // 2️⃣ Validate unique constraints if email or phone is changing
    if (email && email !== doctor.email) {
      const existingUserByEmail = await User.findOne({
        userEmail: email,
        _id: { $ne: doctor.userId },
      }).exec();
      if (existingUserByEmail) {
        return res.status(409).json({
          success: false,
          message: `Email "${email}" is already taken by another user.`,
        });
      }
    }

    if (phonenumber && phonenumber !== doctor.phonenumber) {
      const existingUserByPhone = await User.findOne({
        userPhone: phonenumber,
        _id: { $ne: doctor.userId },
      }).exec();
      if (existingUserByPhone) {
        return res.status(409).json({
          success: false,
          message: `Phone number "${phonenumber}" is already taken by another user.`,
        });
      }
    }

    // 3️⃣ Update the Doctor document
    const doctorUpdate: Record<string, unknown> = {};
    if (firstName !== undefined) doctorUpdate.firstName = firstName;
    if (lastName !== undefined) doctorUpdate.lastName = lastName;
    if (name !== undefined) doctorUpdate.name = name;
    if (phonenumber !== undefined) doctorUpdate.phonenumber = phonenumber;
    if (email !== undefined) doctorUpdate.email = email;
    if (specialization !== undefined) doctorUpdate.specialization = specialization;
    if (bio !== undefined) doctorUpdate.bio = bio;
    if (isActive !== undefined) doctorUpdate.isActive = isActive;
    if (profileImage !== undefined) doctorUpdate.profileImage = profileImage;
    if (certificates !== undefined) doctorUpdate.certificates = certificates;
    if (weekOffDays !== undefined) doctorUpdate.weekOffDays = weekOffDays;

    const updatedDoctor = await Doctor.findOneAndUpdate(
      { doctorId: id },
      { $set: doctorUpdate },
      { new: true, runValidators: true }
    ).exec();

    if (!updatedDoctor) {
      return res.status(404).json({ message: "Therapist update failed" });
    }

    // 4️⃣ Update the linked User document (userEmail, userPhone, name)
    const userUpdate: Record<string, unknown> = {};
    if (email) userUpdate.userEmail = email;
    if (phonenumber) userUpdate.userPhone = phonenumber;
    if (firstName !== undefined) userUpdate.userfName = firstName;
    if (lastName !== undefined) userUpdate.userlName = lastName;
    if (typeof isActive === "boolean") userUpdate.isActive = isActive;

    let updatedUser = null;
    if (doctor.userId && Object.keys(userUpdate).length > 0) {
      updatedUser = await User.findByIdAndUpdate(
        doctor.userId,
        { $set: userUpdate },
        { new: true, runValidators: true }
      ).select("-userPassword").exec();
    }

    return res.json({
      success: true,
      message: "Therapist updated successfully",
      updatedDoctor,
      updatedUser: updatedUser ? {
        _id: updatedUser._id,
        userName: updatedUser.userName,
        userEmail: updatedUser.userEmail,
        userPhone: updatedUser.userPhone,
        isActive: updatedUser.isActive,
      } : null,
    });
  } catch (error) {
    console.error("Super-admin therapist update error:", error);
    return res.status(500).json({ message: "Error updating therapist", error });
  }
}

export async function deleteDoctor(req: Request, res: Response) {
  try {
    const { id } = req.params;

    const appointmentCount = await AppointmentBookingModel.countDocuments({
      doctorId: id,
    });
    if (appointmentCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Cannot delete - this therapist has ${appointmentCount} appointment(s).`,
      });
    }

    const deletedDoctor = await Doctor.findOneAndDelete({ doctorId: id });

    if (!deletedDoctor) {
      return res.status(404).json({ message: "Doctor not found" });
    }

    // Deactivate the linked login account so the removed therapist can no
    // longer sign in (userAuth blocks inactive users). Deactivated rather than
    // hard-deleted so any audit references stay intact.
    if (deletedDoctor.userId) {
      await User.findByIdAndUpdate(deletedDoctor.userId, {
        isActive: false,
      }).catch(() => {});
    }

    return res.json({ message: "Doctor deleted successfully" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error deleting doctor", error });
  }
}

/**
 * Super-admin-only: hard-delete a therapist completely.
 * - Checks appointments by doctorId AND by doctor name string
 * - Aborts if any appointments exist (to protect data integrity)
 * - Hard-deletes the linked User login (frees userEmail / userPhone via unique constraint)
 * - Hard-deletes the Doctor doc
 * - Deletes TherapistLeave records matching doctorId
 * - Returns verification counts
 */
export async function deleteTherapistSuperAdmin(req: Request, res: Response) {
  try {
    const { id } = req.params;

    // 1️⃣ Check appointments that reference this therapist
    //    - by doctorId (ObjectId reference)
    //    - by doctor (display name String, also used in some queries)
    const appointmentCountById = await AppointmentBookingModel.countDocuments({
      doctorId: id,
    }).exec();

    const appointmentCountByName = await AppointmentBookingModel.countDocuments({
      doctor: id,
    }).exec();

    const totalAppointments = appointmentCountById + appointmentCountByName;

    if (totalAppointments > 0) {
      return res.status(409).json({
        success: false,
        message: `Cannot delete - this therapist has ${totalAppointments} appointment(s) (by doctorId: ${appointmentCountById}, by doctor name: ${appointmentCountByName}).`,
      });
    }

    // 2️⃣ Find the doctor doc to get userId and doctorId
    const doctor = await Doctor.findOne({ doctorId: id }).lean().exec();
    if (!doctor) {
      return res.status(404).json({ message: "Therapist not found" });
    }

    const userId = doctor.userId;
    const doctorId = doctor.doctorId;

    // 3️⃣ Hard-delete the linked User login (frees userEmail / userPhone via unique constraint)
    await User.findByIdAndDelete(userId).catch(() => {});

    // 4️⃣ Hard-delete the Doctor doc
    await Doctor.findOneAndDelete({ doctorId: id }).catch(() => {});

    // 5️⃣ Delete TherapistLeave records matching doctorId
    //    (TherapistLeave has doctorId as String, required, indexed)
    await TherapistLeave.deleteMany({ doctorId: doctorId }).catch(() => {});

    // 6️⃣ Verification: re-count leftovers
    const remainingDoctors = await Doctor.countDocuments({ doctorId: id }).exec();
    const remainingByEmail = await User.countDocuments({
      userEmail: doctor.email,
    }).exec();

    return res.json({
      success: true,
      message: "Therapist hard-deleted successfully",
      verification: {
        remainingDoctors,
        remainingUsersByEmail: remainingByEmail,
      },
    });
  } catch (error) {
    console.error("Super-admin therapist deletion error:", error);
    return res.status(500).json({ message: "Error deleting therapist", error });
  }
}