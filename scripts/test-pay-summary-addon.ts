/**
 * Smoke test: public pay summary must reflect unpaid add-ons, not just
 * booking.paymentReceived.
 *
 * Run: npx tsx scripts/test-pay-summary-addon.ts
 */
import { bookingLedger } from "../lib/bookingMoney.ts";

const paidBookingWithUnpaidAddon = {
  enquiryId: "ENQ-0055",
  quotedPrice: 500,
  paymentReceived: true,
  typeOfappointment: "consultation",
  recommendedServices: [
    {
      serviceId: "acc",
      serviceName: "Accupuncture",
      quotedPrice: 1500,
      status: "confirmed",
      recommendedAt: "2026-08-05T10:00:00.000Z",
      paymentCollected: false,
    },
  ],
};

const { due, lines } = bookingLedger(paidBookingWithUnpaidAddon);
const items = lines.filter((l) => l.state === "due");

console.log("due:", due);
console.log("items:", items);
console.log("paymentReceived (should be false):", due <= 0);

const ok =
  due === 1500 &&
  items.length === 1 &&
  items[0].label === "Accupuncture" &&
  due <= 0 === false;

console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
