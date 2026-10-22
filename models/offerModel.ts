import mongoose, { Schema } from "mongoose";

/**
 * A single discount / Offer. One merged entity covers what used to be a
 * "coupon code" and a "discount": it can be a percent or a fixed amount, may be
 * scoped to certain services / line kinds, gated to a minimum role, time-boxed,
 * and usage-capped. Money is NEVER stored here as a final price — the
 * apply-offer endpoint works out the rupees from a line's base at apply time
 * (see lib/offers.ts). Creation/update/delete is Super-Admin only (route gate).
 */
const offerSchema = new Schema(
  {
    // Human-readable sequential ID, e.g. "OFF-0001" (lib/counters pattern).
    offerId: { type: String, unique: true, sparse: true, index: true },

    name: { type: String, required: true, trim: true },

    // Optional promo code customers/office type in. Uppercased + unique so
    // "Diwali" and "DIWALI" can't both exist. Blank/absent = no code (the offer
    // is picked by id from the dashboard dropdown instead).
    code: {
      type: String,
      trim: true,
      uppercase: true,
      unique: true,
      sparse: true,
    },

    kind: { type: String, enum: ["fixed", "percent"], required: true },
    // percent = % of base (0-100+ but hard-capped at 100% at apply time);
    // fixed = rupees off the base.
    amount: { type: Number, required: true, min: 0 },
    // For percent offers: the most rupees this can ever take off. null = no cap.
    maxOff: { type: Number, min: 0, default: null },

    // Which priced lines this offer may touch. "all" = main/course + add-ons.
    appliesTo: {
      type: String,
      enum: ["all", "services", "courses", "add_ons"],
      default: "all",
    },
    // When appliesTo === "services", an allow-list of catalogue serviceIds.
    // Empty/absent = any service.
    serviceIds: [{ type: String }],

    // Lowest dashboard role that may apply this. Staff/Customer Care are the
    // floor; a therapist can never apply an offer (enforced in lib/offers.ts).
    minRole: {
      type: String,
      enum: ["STAFF", "ADMIN", "SUPER_ADMIN"],
      default: "STAFF",
    },
    // Who eats the discount for therapist-revenue split. Booked now, used when
    // earnings are computed (default = the company absorbs it).
    absorbedBy: { type: String, enum: ["company", "therapist"], default: "company" },

    // Validity window (inclusive). null = open-ended on that side.
    validFrom: { type: Date, default: null },
    validUntil: { type: Date, default: null },

    // Usage cap. totalUses null = unlimited; usedCount is bumped atomically on
    // each successful apply.
    totalUses: { type: Number, min: 0, default: null },
    usedCount: { type: Number, min: 0, default: 0 },
    // Default one redemption per phone; set false to allow repeats.
    oncePerPhone: { type: Boolean, default: true },
    // Require the applier to record a reason/note when using this offer.
    noteRequired: { type: Boolean, default: false },

    active: { type: Boolean, default: true },

    createdBy: {
      name: { type: String },
      at: { type: String },
      _id: false,
    },
  },
  { timestamps: true, versionKey: false },
);

const Offer = mongoose.model("Offer", offerSchema);

export default Offer;
