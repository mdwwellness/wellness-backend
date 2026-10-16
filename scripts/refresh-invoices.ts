/**
 * One-time refresh: re-sync every invoice from its booking so it gets the newer
 * details (each line's session date and paid amount, the payments received),
 * and its PDF is rebuilt in the new layout on the next Download. It's the same
 * sync a booking save runs: an open invoice's amounts are re-worked from its
 * booking, a paid one keeps them.
 *
 * Dry run by default: lists every invoice whose amounts would change, saves
 * nothing. Pass --apply to write.
 *   npx tsx scripts/refresh-invoices.ts
 *   npx tsx scripts/refresh-invoices.ts --apply
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Invoice from "../models/invoiceModel.ts";
import Customer from "../models/customerModel.ts";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { syncInvoiceFromAppointment } from "../lib/invoiceGeneration.ts";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const apply = process.argv.includes("--apply");

async function main() {
  await mongoose.connect(process.env.DATABASE_URL!);
  console.log(`${apply ? "APPLYING" : "DRY RUN (pass --apply to write)"}`);

  if (!apply) {
    // Same code path, nothing written.
    (Invoice.prototype as any).save = async function () { return this; };
    (AppointmentBooking.prototype as any).save = async function () { return this; };
    (Customer as any).updateOne = async () => ({});
  }

  const invoices = await Invoice.find({ voided: { $ne: true }, appointment_id: { $ne: null } })
    .select("invoice_id appointment_id total advance_paid balance_due payment_status")
    .lean();
  let changed = 0;
  for (const before of invoices as any[]) {
    const booking = await AppointmentBooking.findById(before.appointment_id).exec();
    if (!booking) {
      console.log(`  ${before.invoice_id}: booking not found, left alone`);
      continue;
    }
    // Raised on a course session or add-on visit by the old bug: its booking's
    // own invoice is the real one, so this one is a duplicate to void.
    if (booking.packageOriginId || (booking as any).addonOf?.bookingId) {
      console.log(`  ${before.invoice_id}: duplicate on visit ${booking.enquiryId}, left alone - void it on the Invoices page`);
      continue;
    }
    const after: any = await syncInvoiceFromAppointment({ appointment: booking, actor: { name: "invoice refresh" } });
    if (!after) continue;
    const money = (i: any) => `total ${i.total}, paid ${i.advance_paid}, due ${i.balance_due}, ${i.payment_status}`;
    if (money(before) !== money(after)) {
      changed++;
      console.log(`  ${before.invoice_id}: ${money(before)}  ->  ${money(after)}`);
    }
  }
  console.log(`Invoices refreshed: ${invoices.length}, amounts changed: ${changed}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
