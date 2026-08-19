import mongoose, { Schema } from "mongoose";

const customerSchema = new Schema(
  {
    customer_id: {
      type: String,
      unique: true,
      index: true,
      sparse: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      // Stored as Number to match appointment phonenumber usage. NOT unique: one
      // household phone can belong to several patients, so identity is
      // phone + name (deduped in ensureCustomerForAppointment / createCustomer),
      // not phone alone.
      type: Number,
      required: true,
      index: true,
    },
    email: {
      type: String,
      default: "",
    },
    address: {
      type: String,
      default: "",
    },
    notes: [
      {
        at: { type: String, required: true },
        by: { type: String, required: true },
        userId: { type: String, default: "" },
        note: { type: String, required: true },
      },
    ],
  },
  { timestamps: true, versionKey: false },
);

const Customer =
  mongoose.models.Customer || mongoose.model("Customer", customerSchema);

export default Customer;

