import mongoose, { Schema } from "mongoose";

import { GENDERS } from "../lib/personDetails.ts";
import { NOTE_KINDS } from "../lib/customerNotes.ts";

export { GENDERS };

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
    // The customer-app login (mdw.users _id) this record belongs to. Sparse so
    // the many records without a login don't collide; never stored as null/"".
    accountId: {
      type: String,
      unique: true,
      sparse: true,
    },
    gender: { type: String, enum: GENDERS },
    dob: Date,
    // From an age given on a booking (this year minus the age). dob wins when set.
    birthYear: Number,
    city: String,
    pincode: String,
    emergencyContact: {
      type: new Schema(
        { name: String, phone: Number, relation: String },
        { _id: false },
      ),
    },
    profilePhotoUrl: String,
    notes: [
      {
        at: { type: String, required: true },
        by: { type: String, required: true },
        userId: { type: String, default: "" },
        note: { type: String, required: true },
        // Who the note is from, set by the server: "office" (staff on the
        // Customers page), "therapist" (a general note by a therapist) or
        // "session" (a copy of a completed session's note, with its booking).
        kind: { type: String, enum: NOTE_KINDS },
        enquiryId: String,
        session: Number,
      },
    ],
  },
  { timestamps: true, versionKey: false },
);

const Customer =
  mongoose.models.Customer || mongoose.model("Customer", customerSchema);

export default Customer;

