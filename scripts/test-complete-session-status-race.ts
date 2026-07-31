import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { completeSession } from "../controllers/appointmentController.ts";

const id = "6a3befa5cff640bfe52d18be";

await mongoose.connect(process.env.DATABASE_URL!);

// Seed the exact false->true race: packageServiceId points at a real
// 6-session package ("Therapy Package (Standard)", packageCount: 6), and
// sessionsCompleted starts at 4. The first of two concurrent completions
// will observe its own post-increment count as 5 (done=false), the second
// will observe 6 (done=true). Before the fix, whichever request's second
// write executed last would win regardless of which was actually the true
// final state - so "scheduled" could beat "completed" even though the real
// count says the package is done.
await AppointmentBooking.findByIdAndUpdate(id, {
  packageServiceId: "SRV-0002",
  sessionsCompleted: 4,
  status: "scheduled",
  $unset: { completedAt: "" },
}).exec();

function makeReqRes() {
  const captured: any[] = [];
  const req: any = {
    params: { id: "6a3befa5cff640bfe52d18be" },
    user: { userfName: "Test", userlName: "Script", userEmail: "test@script.local", id: "test-script" },
  };
  const res: any = {
    status: (code: number) => ({
      send: (payload: any) => { captured.push({ code, payload }); },
    }),
  };
  return { req, res, captured };
}

const a = makeReqRes();
const b = makeReqRes();

await Promise.all([completeSession(a.req, a.res), completeSession(b.req, b.res)]);

console.log("Response A:", JSON.stringify(a.captured));
console.log("Response B:", JSON.stringify(b.captured));

const after = await AppointmentBooking.findById(id).exec();

const sessionsCompletedOk = after?.sessionsCompleted === 6;
const statusOk = after?.status === "completed";
const completedAtOk = after?.completedAt !== null && after?.completedAt !== undefined;

console.log("sessionsCompleted (expect 6):", after?.sessionsCompleted, sessionsCompletedOk ? "PASS" : "FAIL");
console.log("status (expect 'completed'):", after?.status, statusOk ? "PASS" : "FAIL");
console.log("completedAt (expect set):", after?.completedAt, completedAtOk ? "PASS" : "FAIL");

const overall = sessionsCompletedOk && statusOk && completedAtOk;
console.log(overall ? "OVERALL PASS" : "OVERALL FAIL");

// Reset the test appointment to a clean baseline so other tasks reusing
// this same appointment ID aren't affected by this test's seeded state.
await AppointmentBooking.findByIdAndUpdate(id, {
  sessionsCompleted: 0,
  status: "scheduled",
  $unset: { packageServiceId: "", completedAt: "" },
}).exec();

await mongoose.disconnect();

process.exit(overall ? 0 : 1);
