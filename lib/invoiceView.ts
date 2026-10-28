// What the invoice PDF shows, built fresh on every download from the invoice
// (the money: frozen once paid) and its booking (when each visit is, who did
// it, how it was paid).
import AppointmentBooking from "../models/appointmentsBookingModel.ts";
import Customer from "../models/customerModel.ts";
import Invoice from "../models/invoiceModel.ts";
import Service from "../models/serviceModel.ts";
import { addonKey } from "./payments.ts";
import { customerAge } from "./personDetails.ts";
import { clockLabel, dayLabel, paidAtLabel, visitLabel } from "./sessionDates.ts";
import type { InvoiceRow, InvoiceView } from "./invoicePdf.ts";

type InvoiceDoc = InstanceType<typeof Invoice>;
type Line = { description: string; price: number; session?: string | null; paid?: number | null };
type Payment = { amount: number; method?: string; at: Date | string; for?: string };

const ADDON_PREFIX = "Add-on: ";

function methodLabel(m?: string): string {
  if (!m) return "";
  return m.toLowerCase() === "upi" ? "UPI" : m[0].toUpperCase() + m.slice(1);
}

/**
 * Spreads what's been paid on a line over its parts, earliest first: an advance
 * covers session 1, then session 2, and so on. The money is one pot; this is
 * only how the invoice shows it per row. The methods are those of the payments
 * that covered each part.
 */
export function allocatePaid(
  needs: number[],
  paid: number,
  payments: Pick<Payment, "amount" | "method">[],
): { pay: InvoiceRow["pay"]; method?: string }[] {
  const pot = payments.map((p) => ({ left: Number(p.amount) || 0, method: methodLabel(p.method) }));
  let budget = Math.max(0, paid);
  return needs.map((need) => {
    const got = Math.min(need, budget);
    budget -= got;
    const used = new Set<string>();
    for (let want = got; want > 0 && pot.length; ) {
      const take = Math.min(want, pot[0].left);
      if (take > 0 && pot[0].method) used.add(pot[0].method);
      pot[0].left -= take;
      want -= take;
      if (pot[0].left <= 0) pot.shift();
    }
    return {
      pay: got >= need ? "paid" : got > 0 ? "part" : "due",
      method: [...used].join(" + ") || undefined,
    };
  });
}

/**
 * Session n's share of a course price. The same rounding as the visit payment
 * gate (paidNeededBeforeVisit in lib/payments.ts), so the shares add up to the
 * price exactly.
 */
export const sessionShare = (price: number, total: number, n: number) =>
  Math.round((price / total) * n) - Math.round((price / total) * (n - 1));

const done = (visit: any) => visit?.status === "completed";

/** Who did it, or "Upcoming": no therapist is named until the visit is done. */
function who(visit: any, isDone: boolean): Pick<InvoiceRow, "therapistId" | "therapistName" | "upcoming"> {
  if (!isDone) return { upcoming: true };
  return { therapistId: visit?.doctorId || undefined, therapistName: visit?.doctor || undefined };
}

export async function invoiceView(invoice: InvoiceDoc): Promise<InvoiceView> {
  const inv: any = invoice;
  const booking: any = inv.appointment_id ? await AppointmentBooking.findById(inv.appointment_id).lean() : null;
  const id = booking ? String(booking._id) : "";
  const visits: any[] = booking
    ? await AppointmentBooking.find({ $or: [{ packageOriginId: id }, { "addonOf.bookingId": id }] }).lean()
    : [];
  const sessions = visits.filter((v) => v.packageOriginId);
  const addonVisits = visits.filter((v) => v.addonOf?.bookingId);
  const all = booking ? [booking, ...visits] : [];
  const payments: Payment[] = all
    .flatMap((v) => v.payments ?? [])
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const live = all.flatMap((v) =>
    (v.recommendedServices ?? [])
      .filter((r: any) => r?.serviceName && r.status === "confirmed")
      .map((r: any) => ({ r, visit: v })),
  );
  const [pkg, services, customer] = await Promise.all([
    booking?.packageServiceId ? Service.findOne({ serviceId: booking.packageServiceId }).lean() : null,
    live.length ? Service.find({ serviceId: { $in: live.map((a) => a.r.serviceId) } }).lean() : [],
    booking?.age == null ? Customer.findOne({ customer_id: inv.customer_id }).lean() : null,
  ]);
  const serviceById = new Map((services as any[]).map((s) => [s.serviceId, s]));
  const offers: any[] = booking?.appliedOffers ?? [];
  // An offer's pre-offer price, only when this line really is that offer's
  // result; a line priced some other way gets no MRP rather than a wrong one.
  const offerBase = (l: Line, match: (o: any) => boolean) =>
    offers.find((o) => match(o) && Number(o.base) - Number(o.off) === l.price)?.base;

  const online = inv.invoice_type === "online_consultation";
  const lines: Line[] = inv.line_items?.length ? inv.line_items : [{ description: "Service", price: inv.total }];
  const mainLines = lines.filter((l) => !l.description.startsWith(ADDON_PREFIX));
  const addonLines = lines.filter((l) => l.description.startsWith(ADDON_PREFIX));
  const totalSessions = Number(booking?.totalSessions) || Number((pkg as any)?.packageCount) || 1;
  const isPackage = !!booking && !online && totalSessions > 1 && mainLines.length === 1;

  const slot = booking?.consultationSlot?.date ? booking.consultationSlot : booking?.slot;
  const meeting = online ? { date: dayLabel(slot?.date), time: clockLabel(slot?.time) } : undefined;
  // A paid invoice is paid on every line: invoices paid before ISSUES #42 kept
  // their lines from the first payment, so those amounts can be out of date.
  const linePaid = (l: Line) => (inv.payment_status === "paid" ? l.price : Number(l.paid ?? 0));

  const rows: InvoiceRow[] = [];
  let discount = 0;
  const lineBase = (l: Line, base: number | undefined) => {
    const mrp = base != null && base > l.price ? base : undefined;
    if (mrp) discount += mrp - l.price;
    return mrp;
  };
  const mainPayments = payments.filter((p) => !p.for);

  if (isPackage) {
    const line = mainLines[0];
    const base = lineBase(line, offerBase(line, (o) => o.lineKind === "main"));
    const visitOf = (n: number) =>
      n === 1 ? booking : (sessions.find((s) => Number(s.sessionNumber) === n) ?? sessions[n - 2]);
    // A package kept on one booking (no visit per session) counts its sessions done.
    const isDone = (n: number) =>
      sessions.length ? done(visitOf(n)) : n <= (Number(booking.sessionsCompleted) || 0);
    const needs = Array.from({ length: totalSessions }, (_, i) => sessionShare(line.price, totalSessions, i + 1));
    const paid = allocatePaid(needs, linePaid(line), mainPayments);
    needs.forEach((unit, i) => {
      const n = i + 1;
      const visit = visitOf(n) ?? booking;
      rows.push({
        service: `Session ${n} of ${totalSessions}`,
        when: visitOf(n) ? visitLabel(visitOf(n)) : undefined,
        ...paid[i],
        ...who(visit, isDone(n)),
        unit,
        unitMrp: base ? sessionShare(base, totalSessions, n) : undefined,
        qty: 1,
      });
    });
  } else {
    for (const line of mainLines) {
      const isDone = booking ? done(booking) || (online && !!booking.consultationCompleted) : true;
      const [paid] = allocatePaid([line.price], linePaid(line), mainPayments);
      rows.push({
        service: line.description,
        when: line.session || (meeting?.date ? [meeting.date, meeting.time].filter(Boolean).join(", ") : undefined),
        ...paid,
        ...(booking ? who(booking, isDone) : { therapistId: inv.therapist_id || undefined, therapistName: inv.therapist_name || undefined }),
        unit: line.price,
        unitMrp: lineBase(line, mainLines.length === 1 ? offerBase(line, (o) => o.lineKind === "main") : undefined),
        qty: 1,
      });
    }
  }

  const matched = new Set<object>();
  for (const line of addonLines) {
    const name = line.description.slice(ADDON_PREFIX.length);
    const hit =
      live.find((a) => !matched.has(a) && a.r.serviceName === name && Number(a.r.quotedPrice) === line.price) ??
      live.find((a) => !matched.has(a) && a.r.serviceName === name);
    if (hit) matched.add(hit);
    const r = hit?.r;
    const key = r ? addonKey(r.serviceId, r.recommendedAt) : "";
    // Done in the visit it was recommended on, or (booked for later) in its own visit.
    const doneIn = !r
      ? booking // only on the invoice: locked there when its visit completed
      : r.firstInVisit === false
        ? addonVisits.find((v) => v.addonOf.key === key && done(v))
        : done(hit!.visit)
          ? hit!.visit
          : undefined;

    // MRP: an offer's pre-offer price, or the catalogue price when a
    // single-session add-on was sold at the service's discounted price.
    const offered = offerBase(line, (o) => o.lineKind === "add_on" && o.addonKey === key);
    const before = offered ?? line.price;
    const svc: any = r ? serviceById.get(r.serviceId) : undefined;
    const catalogue =
      (Number(r?.sessions) || 1) <= 1 && svc?.discountedPrice === before && svc.originalPrice > before
        ? svc.originalPrice
        : undefined;
    const mrp = lineBase(line, catalogue ?? offered);

    // Per session when it divides evenly; otherwise one row for the lot.
    const count = Number(r?.sessions) || 1;
    const per = Math.round(line.price / count);
    const qty = per * count === line.price ? count : 1;
    const [paid] = allocatePaid([line.price], linePaid(line), payments.filter((p) => p.for === name));
    rows.push({
      service: name,
      when: `Add-on${line.session ? ` · ${line.session}` : ""}`,
      ...paid,
      ...who(doneIn, !!doneIn),
      unit: line.price / qty,
      unitMrp: mrp != null ? mrp / qty : undefined,
      qty,
    });
  }

  const [date, time] = paidAtLabel(inv.createdAt ?? new Date()).split(", ");
  const doctor = booking?.doctor || inv.therapist_name;
  const doctorId = booking?.doctorId || inv.therapist_id;
  const age = booking?.age ?? customerAge(customer as any);
  const payable = Number(inv.total) || 0;

  return {
    invoiceId: inv.invoice_id,
    bookingId: inv.enquiry_id || "-",
    date,
    time,
    billedBy: !inv.created_by || inv.created_by === "system" ? "MDW Wellness" : inv.created_by,
    therapist: doctor ? `${doctor}${doctorId ? ` (${doctorId})` : ""}` : undefined,
    customer: {
      name: inv.customer_name,
      id: inv.customer_id,
      phone: String(inv.customer_phone ?? ""),
      age: age != null ? String(age) : undefined,
    },
    gst: "N/A",
    packageLabel: isPackage
      ? `${(pkg as any)?.name || booking.service || "Therapy"}, ${totalSessions} sessions`
      : undefined,
    address: online ? undefined : booking?.location || inv.address || undefined,
    meeting,
    rows,
    totals: {
      mrp: payable + discount,
      discount,
      payable,
      paid: Number(inv.advance_paid) || 0,
      due: Number(inv.balance_due) || 0,
    },
  };
}
