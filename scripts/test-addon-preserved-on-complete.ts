import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import Invoice from "../models/invoiceModel.ts";
import {
  completeSession,
} from "../controllers/appointmentController.ts";

const APPT_ID = "6a3befa5cff640bfe52d18be"; // test appointment with an existing invoice

function makeReqRes() {
  const captured: any[] = [];
  const req: any = {
    params: { id: APPT_ID },
    user: {
      userfName: "Test",
      userlName: "Script",
      userEmail: "test@script.local",
      id: "test-script",
    },
  };
  const res: any = {
    status: (code: number) => ({
      send: (payload: any) => {
        captured.push({ code, payload });
      },
    }),
  };
  return { req, res, captured };
}

await mongoose.connect(process.env.DATABASE_URL!);

// Arrange: package appointment, one session away from completion, with a
// CONFIRMED + PAID add-on (₹500) on the visit.
const recommendedAt = new Date().toISOString();
await AppointmentBooking.findByIdAndUpdate(APPT_ID, {
  packageServiceId: "SRV-0002", // Therapy Package (Standard), packageCount 6
  sessionsCompleted: 0,
  status: "scheduled",
  recommendedServices: [
    {
      serviceId: "SRV-ADDON-TEST",
      serviceName: "Test Add-on (paid)",
      category: "Therapy",
      quotedPrice: 500,
      status: "confirmed",
      recommendedAt,
      recommendedBy: "test-script",
      paymentCollected: true,
      paymentCollectedAt: new Date().toISOString(),
    },
  ],
}).exec();

// Sync the invoice so it reflects the paid add-on BEFORE completion.
// (completeSession itself will also sync, but we want a clean before-picture.)
const before = await Invoice.findOne({ appointment_id: APPT_ID }).exec();
const beforeHasAddon = (before?.line_items ?? []).some((li: any) =>
  li.description?.includes("Test Add-on (paid)"),
);
console.log("BEFORE - invoice advance_paid:", before?.advance_paid, "| add-on line present:", beforeHasAddon);

// Act: complete the session (locks add-ons, clears recommendedServices, syncs).
const { req, res } = makeReqRes();
await completeSession(req, res);

// Assert: add-on line item and its ₹500 payment survive on the invoice even
// though the appointment's recommendedServices is now cleared.
const appt = await AppointmentBooking.findById(APPT_ID).exec();
const after = await Invoice.findOne({ appointment_id: APPT_ID }).exec();
const afterHasAddon = (after?.line_items ?? []).some((li: any) =>
  li.description?.includes("Test Add-on (paid)"),
);
const lockedHasAddon = (after?.locked_addon_items ?? []).some(
  (l: any) => l.serviceId === "SRV-ADDON-TEST",
);
const advanceIncludesAddon = (after?.advance_paid ?? 0) >= 500;

console.log("AFTER  - recommendedServices cleared:", (appt?.recommendedServices ?? []).length === 0);
console.log("AFTER  - invoice advance_paid:", after?.advance_paid, "| add-on line present:", afterHasAddon, "| locked snapshot present:", lockedHasAddon);

const pass =
  (appt?.recommendedServices ?? []).length === 0 &&
  afterHasAddon &&
  lockedHasAddon &&
  advanceIncludesAddon;
console.log(pass ? "PASS - paid add-on preserved on the invoice after completion" : "FAIL - add-on billing was lost on completion");

// Cleanup: reset the test appointment to a clean baseline. Also strip the
// test add-on from the invoice's locked_addon_items so re-runs stay isolated.
await AppointmentBooking.findByIdAndUpdate(APPT_ID, {
  sessionsCompleted: 0,
  status: "scheduled",
  recommendedServices: [],
  $unset: { packageServiceId: "", completedAt: "" },
}).exec();
await Invoice.updateOne(
  { appointment_id: APPT_ID },
  { $pull: { locked_addon_items: { serviceId: "SRV-ADDON-TEST" } } },
).exec();

await mongoose.disconnect();
