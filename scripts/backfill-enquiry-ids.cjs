// Backfill enquiryId on existing appointmentbookings records that don't have one.
// Allocates IDs in createdAt order so the oldest record gets ENQ-0001.
// Idempotent: skips records that already have an enquiryId.
//
// Run: node scripts/backfill-enquiry-ids.cjs

const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");

function loadEnv() {
    const envPath = path.join(__dirname, "..", ".env");
    if (!fs.existsSync(envPath)) {
        // Fall back to .env.local if .env doesn't exist
        const altPath = path.join(__dirname, "..", ".env.local");
        if (!fs.existsSync(altPath)) {
            throw new Error("No .env or .env.local file found");
        }
        return parseEnv(altPath);
    }
    return parseEnv(envPath);
}

function parseEnv(filepath) {
    const txt = fs.readFileSync(filepath, "utf8");
    const out = {};
    for (const line of txt.split(/\r?\n/)) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

(async () => {
    const env = loadEnv();
    const uri = env.DATABASE_URL || env.MONGODB_URI;
    if (!uri) {
        console.error("DATABASE_URL or MONGODB_URI not set");
        process.exit(1);
    }

    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db("test");
        const col = db.collection("appointmentbookings");
        const counters = db.collection("counters");

        // Find current counter value (if any)
        const existingCounter = await counters.findOne({ _id: "enquiry" });
        let seq = existingCounter?.seq ?? 0;

        // Fetch records missing enquiryId, oldest first
        const cursor = col.find({ enquiryId: { $exists: false } }).sort({ createdAt: 1 });
        const records = await cursor.toArray();

        if (records.length === 0) {
            console.log("No records to backfill.");
            return;
        }

        console.log(`Backfilling ${records.length} records starting from seq ${seq + 1}...`);

        for (const r of records) {
            seq += 1;
            const id = `ENQ-${String(seq).padStart(4, "0")}`;
            await col.updateOne({ _id: r._id }, { $set: { enquiryId: id } });
            console.log(`  ${r._id} -> ${id}  (${r.name ?? "unnamed"})`);
        }

        // Update the counter to the new max
        await counters.updateOne(
            { _id: "enquiry" },
            { $set: { seq } },
            { upsert: true }
        );

        console.log(`Done. Counter is now at ${seq}.`);
    } finally {
        await client.close();
    }
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
