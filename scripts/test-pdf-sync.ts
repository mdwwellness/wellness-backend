import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import Invoice from "../models/invoiceModel.ts";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { syncInvoiceFromAppointment } from "../lib/invoiceGeneration.ts";

const appointmentId = process.argv[2];
if (!appointmentId) {
  console.error(
    "Usage: npx tsx scripts/test-pdf-sync.ts <appointmentId-with-existing-invoice>",
  );
  process.exit(1);
}

await mongoose.connect(process.env.DATABASE_URL!);

const before = await Invoice.findOne({ appointment_id: appointmentId }).exec();
console.log("pdf_url before:", before?.pdf_url ?? "(no invoice found)");

const appointment = await AppointmentBooking.findById(appointmentId).exec();
if (!appointment) {
  console.error("Appointment not found");
  process.exit(1);
}

await syncInvoiceFromAppointment({ appointment });

const after = await Invoice.findOne({ appointment_id: appointmentId }).exec();
console.log("pdf_url after:", after?.pdf_url);
console.log(
  after?.pdf_url && after.pdf_url !== before?.pdf_url ? "PASS" : "FAIL (or check UPLOADTHING_TOKEN in .env)",
);

await mongoose.disconnect();
