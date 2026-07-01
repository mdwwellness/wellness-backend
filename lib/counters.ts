import mongoose from "mongoose";

/**
 * Atomically allocate the next sequence value for a named counter.
 * Used to generate sequential enquiry IDs without race conditions
 * when multiple POST /api/appointments calls arrive concurrently.
 *
 * Uses the `counters` collection: { _id: "enquiry", seq: 42 }
 */
export async function nextSequence(name: string): Promise<number> {
    const counters = mongoose.connection.collection("counters");
    const result = await counters.findOneAndUpdate(
        { _id: name } as any,
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: "after" }
    );
    return result?.seq ?? 1;
}

/**
 * Atomically allocate the next sequence value for a named counter *within a
 * specific calendar year*.
 *
 * Internally this stores counters as:
 *   { _id: `${type}-${year}`, seq: 42 }
 */
export async function nextYearlySequence(type: string, year: number): Promise<number> {
  return nextSequence(`${type}-${year}`);
}
