import Customer, { GENDERS } from "../models/customerModel.ts";
import { validPersonName } from "./customerAccount.ts";
import type { Account } from "./customerAccount.ts";
import { ensureCustomerForAppointment } from "./invoiceGeneration.ts";
import { logger } from "./logger.ts";
import { fromE164, parseIndianMobile } from "./phone.ts";
import { isPlainObject } from "./validation.ts";

type Gender = (typeof GENDERS)[number];

export type CustomerProfile = {
  accountId: string;
  customerId: string | null;
  phone: string;
  name: string | null;
  email: string | null;
  gender: Gender | null;
  dob: string | null;
  age: number | null;
  address: string | null;
  city: string | null;
  pincode: string | null;
  emergencyContact: { name: string; phone: string; relation: string | null } | null;
  profilePhotoUrl: string | null;
  profileComplete: boolean;
};

export type ProfilePatch = {
  identity: { name?: string; email?: string | null };
  wellness: {
    gender?: Gender | null;
    dob?: Date | null;
    address?: string | null;
    city?: string | null;
    pincode?: string | null;
    emergencyContact?: { name: string; phone: number; relation?: string } | null;
  };
};

// Everything this module may write on a Customer. Name is deliberately absent:
// invoice sync and bookings match customers by phone + name, so renaming the
// clinic record from the app would split one customer into two. The app edits
// the account name instead.
const WELLNESS_FIELDS = ["gender", "dob", "address", "city", "pincode", "emergencyContact"] as const;
const PATCH_FIELDS: readonly string[] = ["name", "email", ...WELLNESS_FIELDS];
const CONTACT_FIELDS: readonly string[] = ["name", "phone", "relation"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// India has no DST, so a fixed +05:30 gives the local calendar date.
const IST_OFFSET_MS = 330 * 60_000;

// Customer.accountId stores the account's _id as a string.
export async function findCustomerForAccount(account: Account) {
  return Customer.findOne({ accountId: String(account._id) });
}

// First save with a name reuses the phone + name match (or creates CUST-####),
// then claims it with a guarded update so a record already linked to another
// login is never taken over.
export async function linkCustomerForAccount(account: Account) {
  const linked = await findCustomerForAccount(account);
  if (linked || !account.name) return linked;

  const candidate = await ensureCustomerForAppointment({
    phonenumber: Number(fromE164(account.phoneE164)),
    name: account.name,
    email: account.email ?? "",
  });
  try {
    await Customer.updateOne(
      { _id: candidate._id, accountId: { $exists: false } },
      { $set: { accountId: String(account._id) } },
    );
  } catch (err: any) {
    // A concurrent request linked another record to this login first.
    if (err?.code !== 11000) throw err;
  }

  // Re-read instead of trusting the candidate: a concurrent request may have
  // won the link, or the candidate belongs to another login and stays theirs.
  const customer = await findCustomerForAccount(account);
  if (!customer) {
    logger.warn("Customer record already linked to another login", {
      customerId: candidate.customer_id,
    });
  }
  return customer;
}

export function validateProfilePatch(
  body: unknown,
): { ok: true; patch: ProfilePatch } | { ok: false; message: string } {
  if (!isPlainObject(body) || Object.keys(body).length === 0) {
    return { ok: false, message: "Nothing to update." };
  }
  const keys = Object.keys(body);
  if (keys.includes("phone") || keys.includes("phonenumber")) {
    return { ok: false, message: "Phone can't be changed here." };
  }
  const unknown = keys.filter((k) => !PATCH_FIELDS.includes(k));
  if (unknown.length) {
    return { ok: false, message: `Unknown field(s): ${unknown.join(", ")}.` };
  }

  const patch: ProfilePatch = { identity: {}, wellness: {} };
  const { identity, wellness } = patch;
  try {
    if ("name" in body) identity.name = personName(body.name, "Name");
    if ("email" in body) identity.email = parseEmail(body.email);
    if ("gender" in body) wellness.gender = parseGender(body.gender);
    if ("dob" in body) wellness.dob = parseDob(body.dob);
    if ("address" in body) wellness.address = optionalText(body.address, "Address", 200);
    if ("city" in body) wellness.city = optionalText(body.city, "City", 80);
    if ("pincode" in body) wellness.pincode = parsePincode(body.pincode);
    if ("emergencyContact" in body) {
      wellness.emergencyContact = parseEmergencyContact(body.emergencyContact);
    }
  } catch (err) {
    if (err instanceof InvalidField) return { ok: false, message: err.message };
    throw err;
  }
  return { ok: true, patch };
}

// null clears a field ($unset). Never touches Customer.name (see WELLNESS_FIELDS).
export async function applyWellnessPatch(
  customerId: string,
  wellness: ProfilePatch["wellness"],
  email?: string | null,
): Promise<void> {
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, 1> = {};
  for (const field of WELLNESS_FIELDS) {
    const value = wellness[field];
    if (value === null) $unset[field] = 1;
    else if (value !== undefined) $set[field] = value;
  }
  // The dashboard stores a missing Customer.email as "", so a cleared one is "" too.
  if (email !== undefined) $set.email = email ?? "";

  const update: Record<string, unknown> = {};
  if (Object.keys($set).length) update.$set = $set;
  if (Object.keys($unset).length) update.$unset = $unset;
  if (!Object.keys(update).length) return;
  await Customer.updateOne(byCustomerId(customerId), update);
}

export async function setProfilePhoto(customerId: string, url: string): Promise<void> {
  await Customer.updateOne(byCustomerId(customerId), { $set: { profilePhotoUrl: url } });
}

export function toProfile(account: Account, customer: any | null): CustomerProfile {
  const dob = customer?.dob ? new Date(customer.dob).toISOString().slice(0, 10) : null;
  const contact = customer?.emergencyContact;
  return {
    accountId: String(account._id),
    customerId: customer?.customer_id ?? null,
    phone: fromE164(account.phoneE164),
    name: account.name || customer?.name || null,
    email: account.email || customer?.email || null,
    gender: customer?.gender ?? null,
    dob,
    age: dob ? ageOn(dob, todayInIndia()) : null,
    address: customer?.address || null,
    city: customer?.city || null,
    pincode: customer?.pincode || null,
    emergencyContact:
      contact?.name && contact?.phone
        ? { name: contact.name, phone: String(contact.phone), relation: contact.relation || null }
        : null,
    profilePhotoUrl: customer?.profilePhotoUrl || null,
    profileComplete: Boolean(account.name),
  };
}

// An empty id would leave a filter that matches any customer.
function byCustomerId(customerId: string) {
  if (!customerId) throw new Error("customerId is required");
  return { customer_id: customerId };
}

function todayInIndia(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// Completed years between two YYYY-MM-DD dates. Comparing "MM-DD" strings makes
// a 29 Feb birthday count from 1 Mar in non-leap years.
function ageOn(dob: string, today: string): number {
  const years = Number(today.slice(0, 4)) - Number(dob.slice(0, 4));
  return today.slice(5) < dob.slice(5) ? years - 1 : years;
}

class InvalidField extends Error {}

function invalid(message: string): never {
  throw new InvalidField(message);
}

function personName(v: unknown, label: string): string {
  return validPersonName(v) ?? invalid(`${label} must be 2-80 characters.`);
}

// Blank text clears the field, like null.
function optionalText(v: unknown, label: string, max: number): string | null {
  if (v === null) return null;
  if (typeof v !== "string") invalid(`${label} must be text.`);
  const s = v.trim();
  if (s.length > max) invalid(`${label} must be at most ${max} characters.`);
  return s || null;
}

function parseEmail(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string") invalid("Enter a valid email address.");
  const s = v.trim().toLowerCase();
  if (!s) return null;
  if (s.length > 254 || !EMAIL_RE.test(s)) invalid("Enter a valid email address.");
  return s;
}

function parseGender(v: unknown): Gender | null {
  if (v === null) return null;
  if (!GENDERS.includes(v as Gender)) invalid("Gender must be male, female or other.");
  return v as Gender;
}

function parseDob(v: unknown): Date | null {
  if (v === null) return null;
  const s = typeof v === "string" ? v : "";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null;
  // The round-trip check rejects dates JS would roll over, like 2023-02-30.
  if (!d || isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    invalid("Date of birth must be a real date (YYYY-MM-DD).");
  }
  const today = todayInIndia();
  if (s > today) invalid("Date of birth can't be in the future.");
  if (s < `${Number(today.slice(0, 4)) - 120}${today.slice(4)}`) {
    invalid("Date of birth can't be more than 120 years ago.");
  }
  return d;
}

function parsePincode(v: unknown): string | null {
  if (v === null || v === "") return null;
  const s = typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
  if (!/^[1-9]\d{5}$/.test(s)) invalid("Pincode must be 6 digits.");
  return s;
}

function parseEmergencyContact(v: unknown): ProfilePatch["wellness"]["emergencyContact"] {
  if (v === null) return null;
  if (!isPlainObject(v)) return invalid("Emergency contact needs a name and phone.");
  const extra = Object.keys(v).filter((k) => !CONTACT_FIELDS.includes(k));
  if (extra.length) invalid(`Unknown emergency contact field(s): ${extra.join(", ")}.`);
  const name = personName(v.name, "Emergency contact name");
  const phone10 = parseIndianMobile(v.phone);
  if (!phone10) invalid("Emergency contact phone must be a valid Indian mobile number.");
  const relation = v.relation === undefined ? null : optionalText(v.relation, "Relation", 40);
  return { name, phone: Number(phone10), ...(relation ? { relation } : {}) };
}
