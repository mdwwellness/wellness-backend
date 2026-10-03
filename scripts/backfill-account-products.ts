/**
 * One-time backfill: tag existing customer accounts with products ["wellness"].
 *
 * Accounts live in the shared identity database (IDENTITY_DB, default "mdw"),
 * collection users, which wellness and pharmacy both use. Only the wellness
 * patient site has created accounts so far, so every customer account without
 * a products field is a wellness account. New logins tag themselves.
 *
 * Dry run by default (counts only). Pass --apply to write.
 *   npx tsx scripts/backfill-account-products.ts
 *   npx tsx scripts/backfill-account-products.ts --apply
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { usersCollection } from "../lib/customerAccount.ts";
import { maskPhone } from "../lib/phone.ts";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const apply = process.argv.includes("--apply");
const untagged = { roles: "customer", products: { $exists: false } };

async function main() {
  await mongoose.connect(process.env.DATABASE_URL!);
  console.log(apply ? "APPLYING" : "DRY RUN (pass --apply to write)");

  const users = usersCollection();
  const accounts = await users.find(untagged, { projection: { phoneE164: 1 } }).toArray();
  for (const a of accounts) console.log(`  ${a._id}  ${maskPhone(String(a.phoneE164 ?? ""))}`);
  console.log(`Customer accounts without products -> ["wellness"]: ${accounts.length}`);

  if (apply) {
    const res = await users.updateMany(untagged, { $set: { products: ["wellness"] } });
    console.log(`Tagged: ${res.modifiedCount}`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
