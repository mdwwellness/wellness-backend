import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";

const id = process.argv[2];
if (!id) {
  console.error("Usage: npx tsx scripts/test-complete-session.ts <appointmentId>");
  process.exit(1);
}

await mongoose.connect(process.env.DATABASE_URL!);

await AppointmentBooking.findByIdAndUpdate(id, { sessionsCompleted: 0 }).exec();

// Simulate the old race: two near-simultaneous "complete session" clicks.
// With a blind $set this would collapse to 1; with atomic $inc it must be 2.
await Promise.all([
  AppointmentBooking.findByIdAndUpdate(id, { $inc: { sessionsCompleted: 1 } }).exec(),
  AppointmentBooking.findByIdAndUpdate(id, { $inc: { sessionsCompleted: 1 } }).exec(),
]);

const after = await AppointmentBooking.findById(id).exec();
console.log("sessionsCompleted after 2 concurrent increments (expect 2):", after?.sessionsCompleted);
console.log(after?.sessionsCompleted === 2 ? "PASS" : "FAIL");

await mongoose.disconnect();
