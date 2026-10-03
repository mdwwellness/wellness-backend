import { Doctor } from "../models/doctorsModel.ts";

/**
 * Each therapist has their own revenue split (Doctor.splitPercent), and each
 * booking locks in the split it was completed at (therapistSplitPercent), so
 * changing a therapist's % never rewrites past earnings or payouts.
 */

/** A valid split % (0-100), or null when the value isn't one. */
export function parseSplitPercent(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/** Only these roles may see or set a therapist's split. */
export function canManageSplit(role: string | undefined): boolean {
  return role === "SUPER_ADMIN" || role === "ADMIN";
}

/**
 * Fields to add to a booking's update as it completes: the assigned
 * therapist's current split, unless the booking already has one locked in.
 */
export async function lockedSplitFields(
  currentSplit: number | null | undefined,
  doctorId: string | null | undefined,
): Promise<{ therapistSplitPercent?: number }> {
  if (currentSplit != null || !doctorId) return {};
  const doctor = await Doctor.findOne({ doctorId }, { splitPercent: 1 }).lean();
  const split = parseSplitPercent(doctor?.splitPercent);
  return split == null ? {} : { therapistSplitPercent: split };
}
