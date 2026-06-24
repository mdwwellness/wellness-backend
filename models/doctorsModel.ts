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