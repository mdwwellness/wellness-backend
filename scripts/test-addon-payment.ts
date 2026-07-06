import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";

const id = process.argv[2];
if (!id) {
  console.error("Usage: npx tsx scripts/test-addon-payment.ts <appointmentId>");
  process.exit(1);
}

await mongoose.connect(process.env.DATABASE_URL!);

const recommendedAt = new Date().toISOString();
await AppointmentBooking.findByIdAndUpdate(id, {
  $push: {
    recommendedServices: {
      serviceId: "SRV-TEST",
      serviceName: "Test Add-on",
      quotedPrice: 500,
      status: "confirmed",
      recommendedAt,
      recommendedBy: "test-script",
    },
  },
}).exec();

const before = await AppointmentBooking.findById(id).exec();
const idx = (before?.recommendedServices ?? []).findIndex(
  (r) => r.serviceId === "SRV-TEST" && r.recommendedAt === recommendedAt,
);
console.log(
  "seeded at index",
  idx,
  "paymentCollected before:",
  before?.recommendedServices?.[idx]?.paymentCollected,
);

// Same query shape as setAddonPaymentStatus's $set — proves the update
// targets only this one subdocument's fields.
const path = `recommendedServices.${idx}`;
const updated = await AppointmentBooking.findByIdAndUpdate(
  id,
  {
    $set: {
      [`${path}.paymentCollected`]: true,
      [`${path}.paymentCollectedAt`]: new Date().toISOString(),
    },
  },
  { new: true },
).exec();

const after = updated?.recommendedServices?.[idx];
console.log("paymentCollected after:", after?.paymentCollected, "at:", after?.paymentCollectedAt);
console.log(
  after?.paymentCollected === true &&
    updated?.recommendedServices?.length === before?.recommendedServices?.length
    ? "PASS"
    : "FAIL",
);

await mongoose.disconnect();
