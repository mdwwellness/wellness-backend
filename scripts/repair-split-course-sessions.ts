/**
 * One-off repair: visits of a course stored one booking per session that the
 * old completion treated as a whole package - it bumped sessionsCompleted,
 * moved sessionNumber on and set the visit back to "scheduled" instead of
 * completing it (e.g. ENQ-0112). Each such visit is exactly one session, so it
 * is marked completed again with its own session number.
 *
 * Dry run by default (prints what it would change); pass --apply to write.
 *   DATABASE_URL=... npx tsx scripts/repair-split-course-sessions.ts [--apply]
 */
import mongoose from "mongoose";
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import { courseSessionOf } from "../lib/payments.ts";

const apply = process.argv.includes("--apply");

await mongoose.connect(process.env.DATABASE_URL!);
const candidates = await AppointmentBooking.find({
  bookingKind: "course",
  sessionsCompleted: { $gte: 1 },
  status: { $ne: "completed" },
}).exec();

let fixed = 0;
for (const row of candidates) {
  const own = courseSessionOf(row);
  if (!own) continue; // a one-booking package: its counter is correct
  // When it was really completed: the first completion entry in its log.
  const doneEntry = (row.activityLog ?? []).find((e: any) => /completed/i.test(e.action ?? "") && /Session \d+ of \d+/.test(e.action ?? ""));
  const completedAt = doneEntry?.at ? new Date(String(doneEntry.at)) : new Date();
  console.log(
    `${row.enquiryId}: session ${own.session} of ${own.total} - status ${row.status} -> completed, ` +
      `sessionsCompleted ${row.sessionsCompleted} -> 1, sessionNumber ${row.sessionNumber} -> ${own.session}, completedAt ${completedAt.toISOString()}`,
  );
  if (apply) {
    await AppointmentBooking.updateOne(
      { _id: row._id },
      {
        $set: { status: "completed", sessionsCompleted: 1, sessionNumber: own.session, completedAt },
        $push: {
          activityLog: {
            at: new Date().toISOString(),
            name: "System repair",
            action: `Marked session ${own.session} of ${own.total} completed (the old completion had moved this visit on to the next session instead)`,
          },
        },
      },
    );
  }
  fixed++;
}
console.log(`${fixed} visit(s) ${apply ? "repaired" : "would be repaired (dry run - pass --apply to write)"}.`);
await mongoose.disconnect();
