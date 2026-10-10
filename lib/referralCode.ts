import { randomInt } from "node:crypto";
import { Doctor } from "../models/doctorsModel.ts";

/**
 * Public referral codes: 5 random characters a therapist shares as a link
 * (?ref=CODE) or reads out at a visit. Random so nobody can walk them like the
 * sequential THR-#### ids; O 0 I 1 L are left out because they get misread on
 * the phone and on paper (31 characters, ~28.6M codes).
 */
export const REFERRAL_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 5;
const VALID = new RegExp(`^[${REFERRAL_ALPHABET}]{${LENGTH}}$`);

export function generateReferralCode(): string {
  let code = "";
  for (let i = 0; i < LENGTH; i++) code += REFERRAL_ALPHABET[randomInt(REFERRAL_ALPHABET.length)];
  return code;
}

/** Trimmed + uppercased code, or null when it can't be one (typos are ignored, never errors). */
export function normalizeReferralCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.trim().toUpperCase();
  return VALID.test(code) ? code : null;
}

/**
 * The doctorId of the active therapist who owns `input`, or null. Never throws
 * for bad input: a typo'd code must not fail the customer's booking.
 */
export async function referrerForCode(input: unknown): Promise<string | null> {
  const code = normalizeReferralCode(input);
  if (!code) return null;
  const doctor = await Doctor.findOne({ referralCode: code, isActive: { $ne: false } }, { doctorId: 1 }).lean();
  return doctor?.doctorId ?? null;
}

/**
 * Run `save(code)` with fresh codes until it doesn't hit the unique index.
 * Retrying on the index (not pre-checking) is what makes it race-safe.
 */
export async function withUniqueReferralCode<T>(save: (code: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await save(generateReferralCode());
    } catch (err: any) {
      const clash = err?.code === 11000 && err?.keyPattern?.referralCode;
      if (!clash || attempt >= 4) throw err;
    }
  }
}
