import mongoose from "mongoose";

const doctorsSchema = new mongoose.Schema({
    doctorId: {
        type: String,
        required: true,
        unique: true
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
        required: true,
    },
    isActive: {
        type: Boolean,
        default: true,
    },
    bio: {
        type: String,
    }
},
    { timestamps: true, versionKey: false }
)

export const Doctor = mongoose.model("Doctor", doctorsSchema);