import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import { safeSyncInvoiceFromAppointment } from "../lib/invoiceGeneration.ts";

await mongoose.connect(process.env.DATABASE_URL!);

// A non-ObjectId _id forces Invoice.findOne to throw a Mongoose CastError —
// this simulates any sync failure. safeSyncInvoiceFromAppointment must catch
// it, log it, and return null instead of crashing the process.
const result = await safeSyncInvoiceFromAppointment({
  appointment: { _id: "not-a-valid-object-id" },
});

console.log("result (expect null):", result);
console.log(result === null ? "PASS" : "FAIL");

await mongoose.disconnect();
