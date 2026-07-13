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
        // ── T31 pricing — the service's two prices (used when added to a visit) ──
        // discountedPrice when a therapist recommends it + discount applied, else originalPrice.
        originalPrice: { type: Number, min: 0 },
        discountedPrice: { type: Number, min: 0 },

        // ── DEPRECATED (kept until the T31 data migration, then removed) ──
        // Old flat price + recommended price → replaced by the fields above.
        price: {
            type: Number,
            min: 0,
        },
        recommendedPrice: {
            type: Number,
            min: 0,
        },
        // DEPRECATED (T31): category is going away. Optional until migration.
        category: {
            type: String,
        },
        hsnCode: {
            type: String,
        },
        // ── Package metadata (catalogue model only) ──
        // packageUnit chooses the metric: "sessions" (therapy) OR "weeks"/"months"
        // (vitals plans). packageCount holds the number.
        isPackage: {
            type: Boolean,
            default: false,
        },
        packageUnit: {
            type: String,
            enum: ["sessions", "weeks", "months"],
        },
        packageCount: {
            type: Number,
        },
    },
    { timestamps: true, versionKey: false },
);

const Service = mongoose.model("Service", serviceSchema);

export default Service;
