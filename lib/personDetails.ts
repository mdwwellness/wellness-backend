// A person's gender and age, as kept on the customer record (and copied onto
// each booking). Age is stored as a birth year so it never goes stale; an exact
// date of birth (from the customer app) wins when there is one.

export const GENDERS = ["male", "female", "other"] as const;
export type Gender = (typeof GENDERS)[number];

// India has no DST, so a fixed +05:30 gives the local calendar date.
const IST_OFFSET_MS = 330 * 60_000;

export function todayInIndia(now = Date.now()): string {
  return new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** "Female" or "female" → "female". Anything else ("Prefer not to say") → undefined. */
export function toGender(v: unknown): Gender | undefined {
  const g = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (GENDERS as readonly string[]).includes(g) ? (g as Gender) : undefined;
}

/** A whole age from 1 to 120 ("32" or 32), else undefined. */
export function toAge(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 120 ? n : undefined;
}

/** Birth year from an age given at `at` (a booking's createdAt). Off by at most one year. */
export function birthYearFrom(age: unknown, at?: Date | string): number | undefined {
  const a = toAge(age);
  if (!a) return undefined;
  const t = at ? new Date(at).getTime() : Date.now();
  return Number(todayInIndia(Number.isNaN(t) ? Date.now() : t).slice(0, 4)) - a;
}

// Completed years between two YYYY-MM-DD dates. Comparing "MM-DD" strings makes
// a 29 Feb birthday count from 1 Mar in non-leap years.
export function ageOn(dob: string, today: string): number {
  const years = Number(today.slice(0, 4)) - Number(dob.slice(0, 4));
  return today.slice(5) < dob.slice(5) ? years - 1 : years;
}

/** Current age: exact from the date of birth, else from the birth year. */
export function customerAge(
  c: { dob?: Date | string | null; birthYear?: number | null } | null | undefined,
  today = todayInIndia(),
): number | undefined {
  if (c?.dob) return ageOn(new Date(c.dob).toISOString().slice(0, 10), today);
  if (c?.birthYear) return Number(today.slice(0, 4)) - c.birthYear;
  return undefined;
}
