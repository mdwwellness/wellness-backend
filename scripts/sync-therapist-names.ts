/**
 * One-time migration: populate Doctor.firstName + Doctor.lastName from User model.
 * Run once, then delete.
 *
 * Usage: npx tsx scripts/sync-therapist-names.ts
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import User from "../models/userModel.ts";
import { Doctor } from "../models/doctorsModel.ts";

dotenv.config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"),
});

async function main() {
  await mongoose.connect(process.env.DATABASE_URL || "mongodb://127.0.0.1:27017/test");
  console.log("Connected to MongoDB");

  const therapists = await User.find({ role: "THERAPIST" }).select("userfName userlName").lean();
  console.log(`Found ${therapists.length} therapists`);

  let updated = 0;
  let skipped = 0;

  for (const user of therapists) {
    const firstName = user.userfName || "";
    const lastName = user.userlName || "";
    const newName = `${firstName} ${lastName}`.trim();

    const doctor = await Doctor.findOne({ userId: user._id.toString() }).exec();
    if (!doctor) {
      console.log(`  SKIP ${user._id}: no Doctor record`);
      skipped++;
      continue;
    }

    if (doctor.firstName === firstName && doctor.lastName === lastName) {
      skipped++;
      continue;
    }

    doctor.firstName = firstName;
    doctor.lastName = lastName;
    doctor.name = newName;
    await doctor.save();
    updated++;
    console.log(`  UPDATED ${doctor.doctorId}: firstName="${firstName}", lastName="${lastName}"`);
  }

  console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
