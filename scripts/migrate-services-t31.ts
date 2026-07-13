import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import Service from "../models/serviceModel.ts";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import SessionRate from "../models/sessionRateModel.ts";

/**
 * T31 migration — move onto the corrected model:
 *   1. Services: originalPrice ← price, discountedPrice ← recommendedPrice ?? price;
 *      drop category + the package fields (and any earlier per-service rate fields).
 *   2. Global session-rate table: seed two starter tiers (1–5, 6–10) if the table
 *      is empty — derived from the average old service price. Adjust in the UI after.
 *   3. Bookings: where `service` is empty but `category` holds a real service name,
 *      copy it across to the canonical `service` field.
 *
 * DRY-RUN by default — prints the plan and changes nothing. Pass --apply to write.
 *   npx tsx scripts/migrate-services-t31.ts            # preview
 *   npx tsx scripts/migrate-services-t31.ts --apply    # execute
 */

const APPLY = process.argv.includes("--apply");
const num = (v: unknown) =>
  typeof v === "number" && !Number.isNaN(v) ? v : 0;

await mongoose.connect(process.env.DATABASE_URL!);
console.log(
  APPLY
    ? "── T31 migration: APPLY (writing) ──"
    : "── T31 migration: DRY RUN (pass --apply to write) ──",
);

// ── 1. Services → original / discounted; drop category, package, old rate fields ──
const services = (await Service.find().lean().exec()) as any[];
let svcChanged = 0;
for (const s of services) {
  const price = num(s.price);
  const set = {
    originalPrice: s.originalPrice != null ? s.originalPrice : price,
    discountedPrice:
      s.discountedPrice != null
        ? s.discountedPrice
        : num(s.recommendedPrice ?? price),
  };
  console.log(
    `  ${s.serviceId ?? s._id} "${s.name}"  →  orig:₹${set.originalPrice}  disc:₹${set.discountedPrice}  (drop category/package)`,
  );
  if (APPLY) {
    await Service.updateOne(
      { _id: s._id },
      {
        $set: set,
        $unset: {
          category: "",
          isPackage: "",
          packageUnit: "",
          packageCount: "",
          rate1to5: "",
          rate6to10: "",
        },
      },
    ).exec();
  }
  svcChanged++;
}

// ── 2. Seed the global session-rate table if it's empty ──
const existing = (await SessionRate.findOne({ key: "global" })
  .lean()
  .exec()) as any;
let seeded = false;
if (!existing?.tiers?.length) {
  const prices = services
    .map((s) => num(s.originalPrice ?? s.price))
    .filter((p) => p > 0);
  const avg = prices.length
    ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)
    : 500;
  const tiers = [
    { from: 1, to: 5, rate: avg },
    { from: 6, to: 10, rate: Math.round(avg * 0.85) },
  ];
  console.log(
    `  session-rate table empty → seed tiers 1–5:₹${tiers[0].rate}, 6–10:₹${tiers[1].rate} (adjust in the UI)`,
  );
  if (APPLY) {
    await SessionRate.findOneAndUpdate(
      { key: "global" },
      { $set: { tiers } },
      { upsert: true },
    ).exec();
  }
  seeded = true;
} else {
  console.log(
    `  session-rate table already has ${existing.tiers.length} tier(s) — left as is.`,
  );
}

// ── 3. Old bookings → copy category into service when category is a real service ──
const serviceNames = new Set(services.map((s) => s.name).filter(Boolean));
const bookings = (await AppointmentBooking.find({
  $and: [
    { $or: [{ service: { $exists: false } }, { service: "" }, { service: null }] },
    { category: { $nin: [null, ""] } },
  ],
})
  .lean()
  .exec()) as any[];
let bkChanged = 0;
for (const b of bookings) {
  if (!serviceNames.has(b.category)) continue;
  console.log(`  booking ${b.enquiryId ?? b._id}: service ← "${b.category}"`);
  if (APPLY) {
    await AppointmentBooking.updateOne(
      { _id: b._id },
      { $set: { service: b.category } },
    ).exec();
  }
  bkChanged++;
}

console.log(
  `\n${APPLY ? "Applied" : "Would change"}: ${svcChanged} service(s)${seeded ? " · seeded rate table" : ""} · ${bkChanged} booking(s).`,
);
await mongoose.disconnect();
