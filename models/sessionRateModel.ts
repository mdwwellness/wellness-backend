import mongoose, { Schema } from "mongoose";

/**
 * Global session-rate table (T31) - a single document holding an ordered list
 * of tiers. A course of N sessions is priced by the tier whose [from, to] range
 * contains N (`to: null` = "from and above"), at `rate` per session.
 *
 * The tiers are fully user-defined and editable (add/remove rows, any ranges) -
 * this model imposes no fixed 1-5 / 6-10 bands.
 */
const tierSchema = new Schema(
    {
        from: { type: Number, required: true, min: 0 }, // min sessions (inclusive)
        to: { type: Number, default: null }, // max sessions (inclusive); null = open-ended
        rate: { type: Number, required: true, min: 0 }, // ₹ per session
    },
    { _id: false },
);

const sessionRateSchema = new Schema(
    {
        // Singleton key so there is exactly one global table (upserted by key).
        key: { type: String, default: "global", unique: true },
        tiers: { type: [tierSchema], default: [] },
    },
    { timestamps: true, versionKey: false },
);

const SessionRate = mongoose.model("SessionRate", sessionRateSchema);

export default SessionRate;
