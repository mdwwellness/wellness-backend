import Customer from "../models/customerModel.ts";

/**
 * COD blacklist (owner's rules, 2026-11-13): the office can stop taking cash
 * from a customer. Their bookings show "COD BLACKLISTED", and no cash payment
 * is recorded for them, at booking or later. UPI, card and payment links still
 * work. The flag lives only on the Customer.
 *
 * A booking is the customer's by its customer_id, or by phone + name (the
 * identity rule, see ensureCustomerForAppointment): a course's later sessions
 * and older bookings carry no customer_id.
 */

export const COD_BLOCKED_MESSAGE = "This customer is COD blacklisted: take UPI, card or a payment link, not cash.";

// KEEP IN SYNC with identityKey in the dashboard's data/customer/customer.ts.
const person = (phone: unknown, name: unknown) => `${Number(phone)}|${String(name ?? "").trim().toLowerCase()}`;

/** A test for "is this booking's customer blacklisted?", loading the (short) blacklist once. */
export async function codBlockedCheck(): Promise<(row: any) => boolean> {
  const blocked: any[] = await Customer.find({ codBlocked: true }, { customer_id: 1, phone: 1, name: 1 }).lean();
  const ids = new Set(blocked.map((c) => c.customer_id).filter(Boolean));
  const people = new Set(blocked.map((c) => person(c.phone, c.name)));
  return (row) => (!!row?.customer_id && ids.has(row.customer_id)) || people.has(person(row?.phonenumber, row?.name));
}

/** Booking rows for the dashboard, with `codBlocked: true` on those whose customer is blacklisted. */
export async function withCodBlock<T extends Record<string, any>>(rows: T[]): Promise<T[]> {
  const blocked = await codBlockedCheck();
  return rows.map((r) => (blocked(r) ? { ...r, codBlocked: true } : r));
}
