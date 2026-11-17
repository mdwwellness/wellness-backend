import mongoose from "mongoose";

/**
 * Money that changed hands between the clinic and a therapist outside a
 * booking: the clinic paying what it owes ("paid"), or the therapist handing
 * back cash they collected ("received"). A therapist's balance is their
 * earnings less the cash they hold, less what was paid, plus what came back
 * (lib/payouts.ts payoutBalances). Admin / Super Admin only.
 */
const therapistSettlementSchema = new mongoose.Schema(
  {
    doctorId: { type: String, required: true, index: true },
    amount: { type: Number, required: true, min: 1 },
    direction: { type: String, required: true, enum: ["paid", "received"] },
    note: { type: String, default: "" },
    by: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false },
);

export const TherapistSettlement = mongoose.model("TherapistSettlement", therapistSettlementSchema);
