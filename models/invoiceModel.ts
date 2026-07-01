import mongoose, { Schema } from "mongoose";

const lineItemSchema = new Schema(
  {
    description: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const invoiceSchema = new Schema(
  {
    // Human-readable sequential ID (yearly reset): INV-2026-0001
    invoice_id: {
      type: String,
      unique: true,
      index: true,
      sparse: true,
    },

    // Link to source appointment for idempotency (optional for manual invoices).
    appointment_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: false,
      unique: true,
      sparse: true,
      index: true,
      ref: "AppointmentBooking",
    },

    enquiry_id: {
      type: String,
      default: "",
      index: true,
    },

    invoice_type: {
      type: String,
      required: true,
      enum: [
        "package_purchase",
        "therapy_session",
        "therapy_addon_standalone",
        "online_consultation",
        "vitals_subscription", // reserved
      ],
    },

    // Customer snapshot at invoice generation time.
    customer_id: { type: String, required: true, index: true },
    customer_name: { type: String, required: true },
    customer_phone: { type: Number, required: true },

    // Package context (invoice-level only)
    package_type: { type: String, default: null },
    package_ref: { type: String, default: null },
    package_name: { type: String, default: "" },
    session_number: { type: String, default: null },

    therapist_name: { type: String, default: "" },

    line_items: { type: [lineItemSchema], default: [] },
    items_subtotal: { type: Number, default: 0 },
    advance_paid: { type: Number, default: 0 },
    balance_due: { type: Number, default: 0 },
    total: { type: Number, default: 0 },

    payment_status: {
      type: String,
      required: true,
      enum: ["paid", "pending"],
      default: "pending",
    },

    pdf_url: { type: String, default: null },

    created_by: { type: String, default: "system" },
    last_edited_by: { type: String, default: null },
    last_edited_at: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

const Invoice =
  mongoose.models.Invoice || mongoose.model("Invoice", invoiceSchema);

export default Invoice;

