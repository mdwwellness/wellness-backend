// How the invoice says when each thing is done ("Session date"), and when a
// payment came in. One style everywhere: "16 Oct 2026, 4:30 PM".

/** "16 Oct 2026" for a slot date: a "yyyy-MM-dd" string or a Date at midnight UTC. */
export function dayLabel(d: unknown): string | undefined {
  if (!d) return undefined;
  const date = typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00Z`) : new Date(d as any);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** "3:30 PM" for "15:30" (or "9:30"). */
export function clockLabel(t: unknown): string | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? "").trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

type Visit = {
  slot?: { date?: unknown; time?: unknown } | null;
  physioSlot?: { date?: unknown; time?: unknown } | null;
  therapyStartTime?: unknown;
};

/** When a visit happens: "16 Oct 2026, 4:30 PM", or just the day. */
export function visitLabel(v: Visit | undefined): string | undefined {
  const day = dayLabel(v?.slot?.date ?? v?.physioSlot?.date);
  if (!day) return undefined;
  const time = clockLabel(v?.therapyStartTime || v?.physioSlot?.time || v?.slot?.time);
  return time ? `${day}, ${time}` : day;
}

/** A course over several visits: "16 Oct 2026 to 6 Nov 2026, 4 sessions". */
export function courseLabel(dates: unknown[]): string | undefined {
  const days = dates
    .map((d) => (typeof d === "string" ? d.slice(0, 10) : d ? new Date(d as any).toISOString().slice(0, 10) : ""))
    .filter(Boolean)
    .sort();
  if (!days.length) return undefined;
  const range = days.length > 1 ? `${dayLabel(days[0])} to ${dayLabel(days[days.length - 1])}` : dayLabel(days[0]);
  return `${range}, ${days.length} session${days.length === 1 ? "" : "s"}`;
}

/**
 * When an add-on is done. Done in the visit it was recommended on: that day,
 * "same visit". Booked for later: its own day and time. More sessions: how many
 * more and how often. Older add-ons had no schedule and were done in the visit.
 */
export function addonLabel(
  rec: { slot?: { date?: unknown; time?: unknown } | null; firstInVisit?: boolean | null; sessions?: number | null; intervalDays?: number | null },
  visit: Visit | undefined,
): string | undefined {
  const first = !rec.slot?.date || rec.firstInVisit
    ? (() => {
        const day = dayLabel(rec.slot?.date) ?? dayLabel(visit?.slot?.date ?? visit?.physioSlot?.date);
        return day ? `${day}, same visit` : undefined;
      })()
    : visitLabel({ slot: rec.slot });
  if (!first) return undefined;
  const more = (Number(rec.sessions) || 1) - 1;
  return more > 0 ? `${first} + ${more} more, every ${rec.intervalDays ?? "?"} days` : first;
}

/** When a payment came in, in India: "16 Oct 2026, 12:49 PM". */
export function paidAtLabel(at: unknown): string {
  const d = new Date(at as any);
  if (Number.isNaN(d.getTime())) return "";
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
  return `${day}, ${time}`;
}
