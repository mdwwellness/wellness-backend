/**
 * One-time check that the clinic Google account can create Meet links.
 * Needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN in .env.
 *
 *   npx tsx scripts/google-meet-test.ts                 creates a test event 1 hour from now
 *   npx tsx scripts/google-meet-test.ts --delete <id>   removes that test event
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createMeetEvent, deleteMeetEvent, googleMeetConfigured } from "../lib/googleMeet.ts";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

async function main() {
  if (!googleMeetConfigured()) {
    console.log("Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET or GOOGLE_REFRESH_TOKEN in .env");
    process.exit(1);
  }
  const del = process.argv.indexOf("--delete");
  if (del !== -1) {
    await deleteMeetEvent(process.argv[del + 1]);
    console.log("Test event deleted.");
    return;
  }
  const start = new Date(Date.now() + 60 * 60_000);
  const { eventId, meetLink } = await createMeetEvent({
    summary: "MDW Wellness - test online consultation",
    description: "Created by scripts/google-meet-test.ts. Safe to delete.",
    start,
    end: new Date(start.getTime() + 30 * 60_000),
  });
  console.log(`Meet link: ${meetLink}`);
  console.log(`Event id:  ${eventId}`);
  console.log(`Delete it: npx tsx scripts/google-meet-test.ts --delete ${eventId}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
