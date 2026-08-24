import mongoose from "mongoose";

const therapistLeaveSchema = new mongoose.Schema(
  {
    doctorId: {
      type: String,
      required: true,
      index: true,
    },
    startDate: {
      type: String, // ISO date string YYYY-MM-DD
      required: true,
    },
    endDate: {
      type: String, // ISO date string YYYY-MM-DD, same as startDate for single-day
      required: true,
    },
    reason: {
      type: String,
      default: "",
    },
  },
  { timestamps: true, versionKey: false },
);

// Compound index for efficient date-range queries per therapist
therapistLeaveSchema.index({ doctorId: 1, startDate: 1, endDate: 1 });

export const TherapistLeave = mongoose.model(
  "TherapistLeave",
  therapistLeaveSchema,
);
