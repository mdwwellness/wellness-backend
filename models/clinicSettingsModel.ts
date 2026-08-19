import mongoose, { Schema } from "mongoose";

// Singleton clinic-wide settings (upserted by key). Home for small operational
// toggles; today just the minimum gap the booking UI warns below.
const clinicSettingsSchema = new Schema(
  {
    key: { type: String, default: "global", unique: true },
    bookingGapMinutes: { type: Number, default: 60, min: 0 },
    // Global default therapist revenue split (percentage). Per-therapist
    // splitPercent on the Doctor document overrides this when set.
    therapistSplitPercent: { type: Number, default: 60, min: 0, max: 100 },
  },
  { timestamps: true, versionKey: false },
);

const ClinicSettings = mongoose.model("ClinicSettings", clinicSettingsSchema);
export default ClinicSettings;
