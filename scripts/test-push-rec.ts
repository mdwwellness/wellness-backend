import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";

const id = process.argv[2] ?? "6a43a673d8c30e8cabc1cf86";

await mongoose.connect(process.env.DATABASE_URL!);
const appt = await AppointmentBooking.findById(id).exec();
console.log("found", !!appt, appt?.name, appt?.appointmentKind);

const entry = {
  serviceId: "SRV-0001",
  serviceName: "Online Consultation",
  category: "Consultation",
  quotedPrice: 450,
  status: "pending",
  recommendedAt: new Date().toISOString(),
  recommendedBy: "test",
};

const updated = await AppointmentBooking.findByIdAndUpdate(
  id,
  { $push: { recommendedServices: entry } },
  { new: true },
).exec();

console.log("after push", updated?.recommendedServices?.length);
console.log(JSON.stringify(updated?.recommendedServices, null, 2));
await mongoose.disconnect();
