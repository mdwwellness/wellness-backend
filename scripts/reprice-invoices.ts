/**
 * One-time fix for invoices that missed a change to their booking (ISSUES #41,
 * #42): a dashboard-booked consultation billed at a flat ₹500, an offer applied
 * or removed after the invoice was raised, or an add-on confirmed after the
 * invoice was paid (paid invoices used to freeze). Lists every invoice whose
 * money differs from what the invoice sync now works out for its booking, before
 * and after, and --apply runs that sync on them.
 *
 * Run it AFTER the fixed backend is deployed, or a save on the old one can put
 * a consultation back to ₹500.
 *
 * Dry run by default. Pass --apply to write.
 *   npx tsx scripts/reprice-invoices.ts
 *   npx tsx scripts/reprice-invoices.ts --apply
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import Invoice from "../models/invoiceModel.ts";
import { invoiceMoneyFor, safeSyncInvoiceFromAppointment } from "../lib/invoiceGeneration.ts";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const apply = process.argv.includes("--apply");
const money = (m: any) => `₹${m.total} (paid ₹${m.advance_paid}, ${m.payment_status})`;

async function main() {
  await mongoose.connect(process.env.DATABASE_URL!);
  console.log(apply ? "APPLYING" : "DRY RUN (pass --apply to write)");

  const invoices = await Invoice.find({ voided: { $ne: true }, appointment_id: { $ne: null } }).lean();
  let changed = 0;
  for (const inv of invoices as any[]) {
    const booking: any = await AppointmentBooking.findById(inv.appointment_id).lean();
    if (!booking) continue;
    // A visit never has its own invoice; one that does is a duplicate (ISSUES
    // #25) and syncing it would update its booking's invoice instead.
    if (booking.packageOriginId || booking.addonOf?.bookingId) {
      console.log(`  skipped: ${inv.invoice_id} ${booking.enquiryId} is a duplicate on a visit (ISSUES #25): void it by hand`);
      continue;
    }
    const now = await invoiceMoneyFor(booking, inv.locked_addon_items);
    if (now.total === inv.total && now.advance_paid === inv.advance_paid && now.payment_status === inv.payment_status) continue;

    changed++;
    const reopens = inv.payment_status === "paid" && now.payment_status !== "paid" ? `  <- was paid, would show ₹${now.balance_due} due` : "";
    const what = `${inv.invoice_id} ${booking.enquiryId}: ${money(inv)} -> ${money(now)}${reopens}`;
    if (!apply) {
      console.log(`  would re-price: ${what}`);
      continue;
    }
    const synced: any = await safeSyncInvoiceFromAppointment({
      appointment: booking,
      actor: { name: "Invoice re-price (ISSUES #41/#42)" },
    });
    console.log(`  re-priced: ${what}; saved ${synced ? money(synced) : "FAILED"}`);
  }
  console.log(`Checked ${invoices.length}. ${apply ? "Re-priced" : "To re-price"}: ${changed}.`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
