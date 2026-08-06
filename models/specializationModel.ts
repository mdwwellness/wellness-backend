import mongoose from "mongoose";

const specializationSchema = new mongoose.Schema(
    {
        value: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            lowercase: true,
        },
        label: {
            type: String,
            required: true,
            trim: true,
        },
    },
    { timestamps: true, versionKey: false },
);

export const Specialization = mongoose.model(
    "Specialization",
    specializationSchema,
);
