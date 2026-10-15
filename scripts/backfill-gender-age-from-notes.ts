/**
 * One-time backfill: website bookings from 2026-10-13 until the fix kept the
 * customer's gender and age only as "Gender: ..." / "Age: ..." lines in the
 * note. This moves them into the real fields (blanks only), drops those lines
 * from the note, and lets the customer record pick them up.
 *
 * Dry run by default (lists what would change). Pass --apply to write.
 *   npx tsx scripts/backfill-gender-age-from-notes.ts
 *   npx tsx scripts/backfill-gender-age-from-notes.ts --apply
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { ensureCustomerForAppointment } from "../lib/invoiceGeneration.ts";
import { toAge, toGender } from "../lib/personDetails.ts";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const apply = process.argv.includes("--apply");
const GENDER_LINE = /^Gender: (.*)$/m;
const AGE_LINE = /^Age: (.*)$/m;

async function main() {
  await mongoose.connect(process.env.DATABASE_URL!);
  console.log(apply ? "APPLYING" : "DRY RUN (pass --apply to write)");

  const rows = await AppointmentBooking.find({ note: { $regex: /^(Gender|Age): /m } });
  for (const row of rows) {
    const note = row.note ?? "";
    const gender = toGender(note.match(GENDER_LINE)?.[1]);
    const age = toAge(note.match(AGE_LINE)?.[1]);
    const cleanNote = note
      .split("\n")
      .filter((l) => !GENDER_LINE.test(l) && !AGE_LINE.test(l))
      .join("\n");

    const changes: string[] = [];
    if (gender && !row.gender) changes.push(`gender=${gender}`);
    if (age && !row.age) changes.push(`age=${age}`);
    console.log(`  ${row.enquiryId} ${row.name}: ${changes.join(", ") || "fields already set"}; note cleaned`);

    if (!apply) continue;
    if (gender && !row.gender) row.gender = gender;
    if (age && !row.age) row.age = age;
    row.note = cleanNote;
    await row.save();
    await ensureCustomerForAppointment(row);
  }
  console.log(`Bookings: ${rows.length}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
