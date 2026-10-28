/**
 * One-time backfill: customer-record notes written before notes had a `kind`.
 * A note whose text matches a session note on one of that customer's bookings
 * (same phone and name) is that session's copy: kind "session" with its booking
 * and session number. Anything else was typed by staff: kind "office". Only
 * notes without a kind are touched.
 *
 * Dry run by default (lists what would change). Pass --apply to write.
 *   npx tsx scripts/backfill-note-kinds.ts
 *   npx tsx scripts/backfill-note-kinds.ts --apply
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Customer from "../models/customerModel.ts";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const apply = process.argv.includes("--apply");
const same = (a?: string | null, b?: string | null) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

async function main() {
  await mongoose.connect(process.env.DATABASE_URL!);
  console.log(apply ? "APPLYING" : "DRY RUN (pass --apply to write)");

  const customers = await Customer.find({ "notes.0": { $exists: true } });
  let session = 0;
  let office = 0;
  for (const c of customers) {
    const bookings = (await AppointmentBooking.find({ phonenumber: c.phone }, { name: 1, enquiryId: 1, sessionNotes: 1 }).lean())
      .filter((b: any) => same(b.name, c.name));
    let changed = false;
    for (const n of c.notes as any[]) {
      if (n.kind) continue;
      const text = (n.note ?? "").trim();
      const match = bookings
        .flatMap((b: any) => (b.sessionNotes ?? []).map((s: any) => ({ b, s })))
        .find(({ s }: any) => (s.note ?? "").trim() === text);
      if (match) {
        n.kind = "session";
        n.enquiryId = match.b.enquiryId;
        n.session = match.s.session;
        session++;
        console.log(`  ${c.customer_id} ${c.name}: session note -> ${match.b.enquiryId} session ${match.s.session}`);
      } else {
        n.kind = "office";
        office++;
        console.log(`  ${c.customer_id} ${c.name}: office note by ${n.by}`);
      }
      changed = true;
    }
    if (apply && changed) await c.save();
  }
  console.log(`Customers: ${customers.length}, session copies: ${session}, office notes: ${office}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
