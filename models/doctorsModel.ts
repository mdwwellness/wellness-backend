import mongoose from "mongoose";

const doctorsSchema = new mongoose.Schema({
    doctorId: {
        type: String,
        required: true,
        unique: true
    },
    // Link to the login account (User._id). Therapists are created with both a
    // Doctor (this roster profile) and a User (login); this ties them together
    // so appointment scoping survives email changes.
    userId: {
        type: String,
    },
    name: {
        type: String,
        required: true,
    },
    gender:{
        type:String,
        requied:true,
        enum:["male","female"],
    },
    email: {
        type: String,
        required: true,
    },
    phonenumber: {
        type: Number,
        required: true,
    },
    specialization: {
        type: [String],
        default: [],
    },
    isActive: {
        type: Boolean,
        default: true,
    },
    bio: {
        type: String,
    },
    // ── Media managed from the dashboard (uploaded via UploadThing) ──
    profileImage: {
        type: String,
    },
    // Per-therapist revenue split override. When set (0-100), this takes
    // precedence over the global therapistSplitPercent in ClinicSettings.
    // null means 'use global default'.
    splitPercent: {
        type: Number,
        default: null,
        min: 0,
        max: 100,
    },
    // ── Weekly off-days (recurring leave) ──
    // Array of day-of-week numbers (0=Sunday, 6=Saturday).
    // e.g. [0] = every Sunday off, [0, 6] = weekends off.
    weekOffDays: {
        type: [Number],
        default: [],
        validate: {
            validator: (v: number[]) => v.every((d) => d >= 0 && d <= 6),
            message: "weekOffDays values must be 0-6 (Sun-Sat)",
        },
    },
    certificates: [
        {
            label: { type: String },
            url: { type: String },
            _id: false,
        },
    ],
},
    { timestamps: true, versionKey: false }
)

export const Doctor = mongoose.model("Doctor", doctorsSchema);