/**
 * One-time backfill: give every existing therapist a referral code (new ones
 * get theirs when they're added). Safe to re-run: only therapists without a
 * code are touched.
 *
 * Dry run by default (counts only). Pass --apply to write.
 *   npx tsx scripts/backfill-referral-codes.ts
 *   npx tsx scripts/backfill-referral-codes.ts --apply
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { Doctor } from "../models/doctorsModel.ts";
import { withUniqueReferralCode } from "../lib/referralCode.ts";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const apply = process.argv.includes("--apply");
const noCode = { $or: [{ referralCode: null }, { referralCode: { $exists: false } }] };

async function main() {
  await mongoose.connect(process.env.DATABASE_URL!);
  console.log(`${apply ? "APPLYING" : "DRY RUN (pass --apply to write)"} on ${mongoose.connection.host}`);
  // The unique index must exist first, or a collision would slip through.
  await Doctor.init();

  const todo = await Doctor.find(noCode, { doctorId: 1, name: 1 }).lean();
  console.log(`Therapists without a referral code: ${todo.length}`);
  for (const d of todo) {
    if (!apply) {
      console.log(`  ${d.doctorId} ${d.name}`);
      continue;
    }
    const code = await withUniqueReferralCode(async (referralCode) => {
      await Doctor.updateOne({ _id: d._id, ...noCode }, { $set: { referralCode } });
      return referralCode;
    });
    console.log(`  ${d.doctorId} ${d.name} -> ${code}`);
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
