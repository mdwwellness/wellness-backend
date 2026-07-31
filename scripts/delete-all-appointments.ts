import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";

/**
 * Delete ALL appointment / booking records - for wiping test data before a
 * fresh end-to-end run. IRREVERSIBLE.
 *
 * DRY-RUN by default - prints the count and changes nothing. Pass --apply to delete.
 *   npx tsx scripts/delete-all-appointments.ts            # preview count
 *   npx tsx scripts/delete-all-appointments.ts --apply    # delete everything
 */

const APPLY = process.argv.includes("--apply");

await mongoose.connect(process.env.DATABASE_URL!);

const count = await AppointmentBooking.countDocuments().exec();
console.log(
  APPLY
    ? `── Delete all appointments: APPLY ── ${count} record(s) will be permanently removed.`
    : `── Delete all appointments: DRY RUN ── ${count} record(s) would be removed (pass --apply to delete).`,
);

if (APPLY) {
  const res = await AppointmentBooking.deleteMany({}).exec();
  console.log(`Deleted ${res.deletedCount} appointment(s).`);
} else {
  console.log("Nothing deleted. Re-run with --apply to execute.");
}

await mongoose.disconnect();
