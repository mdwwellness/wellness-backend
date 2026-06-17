import mongoose, { Schema } from "mongoose";

const serviceSchema = new Schema(
    {
        // Human-readable sequential ID, e.g. "SRV-0001". Allocated atomically
        // on creation via lib/counters (same pattern as enquiry IDs).
        serviceId: {
            type: String,
            unique: true,
            sparse: true,
            index: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
        },
        description: {
            type: String,
        },
        price: {
            type: Number,
            required: true,
            min: 0,
        },
        category: {
            type: String,
            required: true,
        },
        hsnCode: {
            type: String,
        },
    },
    { timestamps: true, versionKey: false },
);

const Service = mongoose.model("Service", serviceSchema);

export default Service;
