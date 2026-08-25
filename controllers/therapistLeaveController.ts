import type { Request, Response } from "express";
import { TherapistLeave } from "../models/therapistLeaveModel.ts";
import { Doctor } from "../models/doctorsModel.ts";

/** GET /api/therapist-leaves — list all leaves (optionally filter by date) */
export async function getLeaves(req: Request, res: Response) {
  try {
    const { doctorId, date } = req.query;
    const filter: any = {};
    if (doctorId) filter.doctorId = doctorId;
    // If a date is provided, return leaves that cover that date
    if (date && typeof date === "string") {
      filter.$or = [
        { startDate: { $lte: date }, endDate: { $gte: date } },
        { startDate: date },
      ];
    }
    const leaves = await TherapistLeave.find(filter)
      .sort({ startDate: 1 })
      .lean();
    return res.status(200).json({ success: true, data: leaves });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

/** POST /api/therapist-leaves — create a new leave block */
export async function createLeave(req: Request, res: Response) {
  try {
    const { doctorId, startDate, endDate, reason } = req.body;
    if (!doctorId || !startDate) {
      return res.status(400).json({
        success: false,
        message: "doctorId and startDate are required",
      });
    }

    const leave = await TherapistLeave.create({
      doctorId,
      startDate,
      endDate: endDate || startDate,
      reason: reason || "",
    });

    return res.status(201).json({ success: true, data: leave });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

/** DELETE /api/therapist-leaves/:id — remove a leave block */
export async function deleteLeave(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const deleted = await TherapistLeave.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Leave not found" });
    }
    return res.status(200).json({ success: true, message: "Leave deleted" });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

/** PATCH /api/therapist/week-off/:doctorId — update weekly off-days */
export async function updateWeekOffDays(req: Request, res: Response) {
  try {
    const { doctorId } = req.params;
    const { weekOffDays } = req.body;

    if (!Array.isArray(weekOffDays)) {
      return res.status(400).json({
        success: false,
        message: "weekOffDays must be an array of numbers 0-6",
      });
    }

    const doctor = await Doctor.findOneAndUpdate(
      { doctorId },
      { weekOffDays },
      { new: true },
    );

    if (!doctor) {
      return res.status(404).json({ success: false, message: "Therapist not found" });
    }

    return res.status(200).json({ success: true, data: doctor });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
}
