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
      // Stored as Number to match appointment phonenumber usage.
      type: Number,
      required: true,
      unique: true,
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
  },
  { timestamps: true, versionKey: false },
);

const Customer =
  mongoose.models.Customer || mongoose.model("Customer", customerSchema);

export default Customer;

