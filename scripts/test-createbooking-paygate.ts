// Run: npx tsx scripts/test-createbooking-paygate.ts
// Asserts the pay-first gate rejects a therapist assignment without cleared
// payment. The reject path returns BEFORE any DB call, so this is safe to run
// without a Mongo connection (and never writes).
import assert from "node:assert";
import { createBooking } from "../lib/bookingService.ts";

// Assigning a therapist without cleared payment must be rejected.
const unpaid = await createBooking(
  { name: "Gate Test", phonenumber: 9999999999, doctorId: "THR-0001" },
  { source: "test" },
);
assert.equal(unpaid.ok, false, "unpaid+therapist should be rejected");
assert.equal((unpaid as any).code, 400);
assert.equal(
  (unpaid as any).message,
  "Record the payment before assigning a therapist.",
);

// Paid but unpriced must also be rejected: an unpriced booking generates no
// invoice at all, so it would silently never bill. Also returns before any DB call.
const unpriced = await createBooking(
  {
    name: "Price Gate Test",
    phonenumber: 9999999999,
    doctorId: "THR-0001",
    paymentReceived: true,
  },
  { source: "test" },
);
assert.equal(unpriced.ok, false, "paid but unpriced should be rejected");
assert.equal((unpriced as any).code, 400);
assert.equal(
  (unpriced as any).message,
  "Set the booking price before assigning a therapist.",
);

// With payment cleared, the gate lets it through (it would then proceed to the
// DB, so we don't execute that path here - the gate is what we're testing).
console.log("PASS: createBooking pay-gate rejects unpaid therapist assignment");
console.log("PASS: createBooking price-gate rejects unpriced therapist assignment");
