// One-off cleanup: find + delete the "Salman Khan" therapist entry.
//
// The regular `deleteDoctor` route only DEACTIVATES the linked login account,
// so the therapist's email/phone stay locked in the User collection. This
// script hard-deletes the Doctor doc AND the linked User account so those
// credentials are freed for reuse.
//
// Runs in two phases:
//   Phase 1 (read-only): prints exactly what would be deleted. No writes.
//   Phase 2 (deletion):  run with --delete to actually apply the cleanup.
//
// Usage (from the backend root, C:\workspace\WellnessBackend):
//   npx tsx scripts/therapist-cleanup.ts          # phase 1, read-only
//   npx tsx scripts/therapist-cleanup.ts --delete # phase 2, performs deletion

import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { Doctor } from "../models/doctorsModel.ts";
import User from "../models/userModel.ts";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { TherapistLeave } from "../models/therapistLeaveModel.ts";

// Mirror server.ts: resolve .env relative to this file (scripts/ -> backend root).
dotenv.config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"),
});

const NAME_PATTERN = /salman\s*khan/i;
const DELETE = process.argv.includes("--delete");

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL missing - cannot connect.");
    process.exit(1);
  }
  await mongoose.connect(process.env.DATABASE_URL);
  console.log(`Connected: ${mongoose.connection.host}`);

  // 1) The Doctor (therapist) roster entry
  const doctors = await Doctor.find({ name: NAME_PATTERN }).lean().exec();
  if (doctors.length === 0) {
    console.log("No Doctor doc matches 'salman khan'. Nothing to do.");
    await mongoose.disconnect();
    return;
  }

  console.log(`\n== Matched Doctor doc(s): ${doctors.length} ==`);
  for (const d of doctors) {
    console.log({
      _id: String(d._id),
      doctorId: d.doctorId,
      userId: d.userId,
      name: d.name,
      email: d.email,
      phonenumber: d.phonenumber,
      isActive: d.isActive,
      createdAt: d.createdAt,
    });
  }

  const userIds = doctors
    .map((d) => d.userId)
    .filter((id): id is string => Boolean(id));
  const doctorIds = doctors.map((d) => String(d.doctorId));

  // 2) Linked login accounts (role THERAPIST) holding email/phone
  const users = await User.find({ _id: { $in: userIds } }).lean().exec();
  console.log(`\n== Linked User account(s): ${users.length} ==`);
  for (const u of users) {
    console.log({
      _id: String(u._id),
      userfName: u.userfName,
      userlName: u.userlName,
      userEmail: u.userEmail,
      userPhone: u.userPhone,
      role: u.role,
      isActive: u.isActive,
    });
    if (u.role !== "THERAPIST") {
      console.log(
        `  !! WARNING: linked user has role '${u.role}', not THERAPIST. ` +
          "Verify before deleting.",
      );
    }
  }

  // 3) Dependent data - appointments + leave records
  const doctorName = doctors.map((d) => d.name);
  const appointmentsByDoctorId = await AppointmentBooking.countDocuments({
    doctorId: { $in: doctorIds },
  });
  // Some records may reference the doctor by display name only.
  const appointmentsByName = await AppointmentBooking.countDocuments({
    doctor: { $in: doctorName },
  });
  const leaves = await TherapistLeave.countDocuments({
    doctorId: { $in: doctorIds },
  });
  console.log(`\n== Dependent records ==`);
  console.log(`Appointments by doctorId: ${appointmentsByDoctorId}`);
  console.log(`Appointments by doctor name: ${appointmentsByName}`);
  console.log(`TherapistLeave records: ${leaves}`);

  if (!DELETE) {
    console.log(
      "\nPhase 1 only (read-only). Re-run with --delete to perform the cleanup.",
    );
    await mongoose.disconnect();
    return;
  }

  // 4) Apply the cleanup
  if (appointmentsByDoctorId > 0 || appointmentsByName > 0) {
    console.log(
      "\nABORT: appointments reference this therapist - refusing to delete. " +
        "Reassign/delete those appointments first, then re-run --delete.",
    );
    await mongoose.disconnect();
    return;
  }

  const delDoctor = await Doctor.deleteMany({ _id: { $in: doctors.map((d) => d._id) } });
  const delUser = await User.deleteMany({ _id: { $in: users.map((u) => u._id) } });
  const delLeaves = await TherapistLeave.deleteMany({ doctorId: { $in: doctorIds } });

  console.log("\n== Cleanup applied ==");
  console.log(`Doctor docs deleted: ${delDoctor.deletedCount}`);
  console.log(`User accounts deleted: ${delUser.deletedCount}`);
  console.log(`TherapistLeave records deleted: ${delLeaves.deletedCount}`);

  // 5) Verify - email/phone must be reusable now
  const leftoverUsers = await User.countDocuments({
    _id: { $in: users.map((u) => u._id) },
  });
  const leftoverDoctors = await Doctor.countDocuments({ _id: { $in: doctors.map((d) => d._id) } });
  console.log(`\nVerification - leftover Doctor docs: ${leftoverDoctors}, leftover User docs: ${leftoverUsers}`);

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});