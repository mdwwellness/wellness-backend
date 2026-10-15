/**
 * Booking balance ledger — mirrors frontend src/lib/booking-money.ts.
 * KEEP IN SYNC: one list of what's sold, what's paid, what's still due.
 */

export type LedgerLine = {
  key: string;
  label: string;
  amount: number;
  state: "paid" | "due" | "pending";
};

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
  }>;
  bookingKind?: string;
  totalSessions?: number;
  typeOfappointment?: string;
}): { lines: LedgerLine[]; due: number; paid: number } {
  const lines: LedgerLine[] = [];

  const fee = appointment.quotedPrice ?? 0;
  if (fee > 0) {
    // Part-paid: the paid share and the balance as two lines.
    const paid = appointment.paymentReceived
      ? fee
      : Math.min(fee, Math.max(0, appointment.paymentAmount ?? 0));
    const label = bookingLabel(appointment);
    if (paid > 0) lines.push({ key: "booking-paid", label, amount: paid, state: "paid" });
    if (paid < fee) {
      lines.push({
        key: "booking",
        label: paid > 0 ? `${label} - balance` : label,
        amount: fee - paid,
        state: "due",
      });
    }
  }

  for (const r of appointment.recommendedServices ?? []) {
    const confirmed = r.status === "confirmed";
    lines.push({
      key: `${r.serviceId}-${r.recommendedAt}`,
      label: r.serviceName,
      amount: r.quotedPrice ?? 0,
      state: !confirmed ? "pending" : r.paymentCollected ? "paid" : "due",
    });
  }

  const sum = (s: LedgerLine["state"]) =>
    lines.filter((l) => l.state === s).reduce((t, l) => t + l.amount, 0);

  return { lines, due: sum("due"), paid: sum("paid") };
}
