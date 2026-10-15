/**
 * Booking balance ledger — mirrors frontend src/lib/booking-money.ts.
 * KEEP IN SYNC: one list of what's sold, what's paid, what's still due.
 */

export type LedgerLine = {
  key: string;
  label: string;
  /** The item's price. */
  amount: number;
  /** Still owed on it (0 when paid; the full price while pending). */
  due: number;
  state: "paid" | "due" | "pending";
};

/** One line per item, part-payments included (mirrors the dashboard). */
function paidLine(key: string, label: string, price: number, paid: number): LedgerLine {
  const due = Math.max(0, price - paid);
  return { key, label, amount: price, due, state: due === 0 ? "paid" : "due" };
}

function bookingLabel(appointment: {
  bookingKind?: string;
  totalSessions?: number;
  typeOfappointment?: string;
}): string {
  const sessions = appointment.totalSessions ?? 0;
  const kind =
    appointment.bookingKind ??
    (sessions >= 1 ? "course" : "intake");
  if (kind === "course") {
    return sessions > 1
      ? `Therapy course (${sessions} sessions)`
      : "Therapy session";
  }
  const labels: Record<string, string> = {
    consultation: "Online consultation",
    appointment: "Home visit",
  };
  return labels[appointment.typeOfappointment ?? ""] ?? "Consultation";
}

/**
 * What the customer can actually be asked to pay on this row. A course
 * follow-up row (packageOriginId set) carries a per-session share of the price
 * for tracking only, because the whole course is billed on session 1, so only
 * its own add-ons count. Shared by the public pay page and the customer app so
 * they never disagree.
 */
export function payableLedger(appointment: {
  packageOriginId?: string | null;
  quotedPrice?: number | null;
  paymentReceived?: boolean | null;
  paymentAmount?: number | null;
  recommendedServices?: Parameters<typeof bookingLedger>[0]["recommendedServices"] | null;
  bookingKind?: string | null;
  totalSessions?: number | null;
  typeOfappointment?: string | null;
}) {
  // Plain copy: callers pass Mongoose documents, whose spread isn't the fields.
  return bookingLedger({
    quotedPrice: appointment.packageOriginId ? 0 : appointment.quotedPrice ?? undefined,
    paymentReceived: appointment.paymentReceived ?? undefined,
    paymentAmount: appointment.paymentAmount ?? undefined,
    recommendedServices: appointment.recommendedServices ?? undefined,
    bookingKind: appointment.bookingKind ?? undefined,
    totalSessions: appointment.totalSessions ?? undefined,
    typeOfappointment: appointment.typeOfappointment ?? undefined,
  });
}

/** Paid so far on an add-on (older add-ons only had a collected flag). */
export const addonPaid = (r: { quotedPrice?: number | null; paidAmount?: number | null; paymentCollected?: boolean | null }) =>
  r?.paidAmount ?? (r?.paymentCollected ? Number(r.quotedPrice) || 0 : 0);

/** Everything sold on this booking with payment state. */
export function bookingLedger(appointment: {
  quotedPrice?: number;
  paymentReceived?: boolean;
  paymentAmount?: number;
  recommendedServices?: Array<{
    serviceId: string;
    serviceName: string;
    quotedPrice: number;
    status?: string;
    recommendedAt: string;
    paymentCollected?: boolean;
    paidAmount?: number | null;
  }>;
  bookingKind?: string;
  totalSessions?: number;
  typeOfappointment?: string;
}): { lines: LedgerLine[]; due: number; paid: number } {
  const lines: LedgerLine[] = [];

  const fee = appointment.quotedPrice ?? 0;
  if (fee > 0) {
    const paid = appointment.paymentReceived
      ? fee
      : Math.min(fee, Math.max(0, appointment.paymentAmount ?? 0));
    lines.push(paidLine("booking", bookingLabel(appointment), fee, paid));
  }

  for (const r of appointment.recommendedServices ?? []) {
    const key = `${r.serviceId}-${r.recommendedAt}`;
    const price = r.quotedPrice ?? 0;
    lines.push(
      r.status !== "confirmed"
        ? { key, label: r.serviceName, amount: price, due: price, state: "pending" }
        : paidLine(key, r.serviceName, price, Math.min(price, addonPaid(r))),
    );
  }

  // Pending add-ons aren't owed yet - the customer hasn't agreed to them.
  const owed = lines.filter((l) => l.state !== "pending");
  return {
    lines,
    due: owed.reduce((t, l) => t + l.due, 0),
    paid: owed.reduce((t, l) => t + l.amount - l.due, 0),
  };
}
