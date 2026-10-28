// A therapist's profile link (LinkedIn, Practo, their own site). It is shown as
// a clickable link, so only http(s) is allowed: never javascript: or data:.

const MAX_LENGTH = 500;

/** The cleaned link, "" to clear it, or null when it isn't an http(s) URL. */
export function parseProfileLink(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return "";
  if (v.length > MAX_LENGTH) return null;
  try {
    const url = new URL(v);
    return url.protocol === "http:" || url.protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}
