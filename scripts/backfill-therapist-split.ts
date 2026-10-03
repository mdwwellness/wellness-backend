/**
 * One-time backfill for per-therapist earnings splits (BD-5).
 *
 * Before this, every therapist was paid the global 60%. This locks that in:
 *   1. every therapist without a split gets 60%;
 *   2. every booking already completed (or already paid out to the therapist)
 *      gets its therapist's split locked in, so changing a therapist's % later
 *      never changes a past earning.
 *
 * Dry run by default (counts only). Pass --apply to write.
 *   npx tsx scripts/backfill-therapist-split.ts
 *   npx tsx scripts/backfill-therapist-split.ts --apply
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { Doctor } from "../models/doctorsModel.ts";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const TODAYS_SPLIT = 60;
const apply = process.argv.includes("--apply");

const noSplit = { $or: [{ splitPercent: null }, { splitPercent: { $exists: false } }] };
const alreadyEarned = {
  therapistSplitPercent: { $exists: false },
  $or: [{ status: "completed" }, { sessionsCompleted: { $gt: 0 } }, { therapistPaid: true }],
};

async function main() {
  await mongoose.connect(process.env.DATABASE_URL!);
  console.log(apply ? "APPLYING" : "DRY RUN (pass --apply to write)");

  const therapistCount = await Doctor.countDocuments(noSplit);
  console.log(`Therapists without a split -> ${TODAYS_SPLIT}%: ${therapistCount}`);
  if (apply) await Doctor.updateMany(noSplit, { $set: { splitPercent: TODAYS_SPLIT } });

  // Lock each therapist's own split onto their past bookings. After step 1
  // (on --apply) that's 60% for everyone; a dry run assumes the same.
  const doctors = await Doctor.find({}, { doctorId: 1, splitPercent: 1 }).lean();
  let bookingCount = 0;
  for (const d of doctors) {
    const filter = { ...alreadyEarned, doctorId: d.doctorId };
    const n = await AppointmentBooking.countDocuments(filter);
    if (n === 0) continue;
    const split = d.splitPercent ?? TODAYS_SPLIT;
    console.log(`  ${d.doctorId}: ${n} past booking(s) -> ${split}%`);
    bookingCount += n;
    if (apply) await AppointmentBooking.updateMany(filter, { $set: { therapistSplitPercent: split } });
  }
  console.log(`Past bookings locked in: ${bookingCount}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
