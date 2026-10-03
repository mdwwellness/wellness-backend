import mongoose from "mongoose";
import { ObjectId } from "mongodb";
import { toE164 } from "./phone.ts";

/**
 * Customer login identity, shared with the patient site
 * (wellness.mydawaiwala.com): one person = one document in `mdw.users`,
 * whichever MDW product they signed in through. The patient site writes the
 * same collection (its src/lib/server/users.ts), so keep the shape in step
 * with it. `products` says which MDW products the person uses.
 */
export type Account = {
  _id: ObjectId;
  phoneE164: string;
  name?: string;
  email?: string;
  referredBy?: string;
  roles: string[];
  status: "active" | "blocked";
  products?: string[];
  createdAt: Date;
  updatedAt: Date;
};

export class AccountBlockedError extends Error {}
export class EmailTakenError extends Error {}

// A getter (not a module-level constant) so tests can mock mongoose, and so
// nothing touches the connection at import time.
export function usersCollection() {
  return mongoose.connection
    .useDb(process.env.IDENTITY_DB || "mdw", { useCache: true })
    .collection<Account>("users");
}

let indexesReady: Promise<void> | null = null;

// Same indexes the patient site creates, so this is a no-op there. The unique
// phone index is what makes the login upsert race-safe.
export function ensureIdentityIndexes(): Promise<void> {
  indexesReady ??= Promise.all([
    usersCollection().createIndex({ phoneE164: 1 }, { unique: true }),
    usersCollection().createIndex({ email: 1 }, { unique: true, sparse: true }),
  ]).then(
    () => undefined,
    (err) => {
      indexesReady = null; // let the next write retry instead of failing forever
      throw err;
    },
  );
  return indexesReady;
}

function isDuplicateKey(err: unknown, field: "phoneE164" | "email"): boolean {
  const e = err as { code?: number; keyPattern?: object; keyValue?: object };
  return e?.code === 11000 && (field in (e.keyPattern ?? {}) || field in (e.keyValue ?? {}));
}

function toObjectId(id: unknown): ObjectId | null {
  return typeof id === "string" && /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : null;
}

export async function findAccountById(id: string): Promise<Account | null> {
  const _id = toObjectId(id);
  return _id ? usersCollection().findOne({ _id }) : null;
}

export async function findAccountByPhone(phone10: string): Promise<Account | null> {
  return usersCollection().findOne({ phoneE164: toE164(phone10) });
}

function upsertWellnessAccount(phoneE164: string) {
  const now = new Date();
  return usersCollection().findOneAndUpdate(
    { phoneE164 },
    {
      $setOnInsert: { phoneE164, roles: ["customer"], status: "active", createdAt: now },
      $addToSet: { products: "wellness" },
      $set: { updatedAt: now },
    },
    // Metadata tells us whether this call inserted the account.
    { upsert: true, returnDocument: "after", includeResultMetadata: true },
  );
}

/** The one rule for a person's name, wherever the app takes one: trimmed, 2-80 characters. */
export function validPersonName(input: unknown): string | null {
  const name = typeof input === "string" ? input.trim() : "";
  return name.length >= 2 && name.length <= 80 ? name : null;
}

// Fills in a missing name only. The filter re-checks so a name set by a
// concurrent login (or the patient site) is never overwritten.
async function setNameIfMissing(account: Account, rawName?: string): Promise<Account> {
  const name = validPersonName(rawName);
  if (account.name || !name) return account;
  const updated = await usersCollection().findOneAndUpdate(
    { _id: account._id, $or: [{ name: { $exists: false } }, { name: "" }] },
    { $set: { name, updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  return updated ?? (await usersCollection().findOne({ _id: account._id })) ?? account;
}

/**
 * Called after a verified OTP: finds or creates the account for this phone and
 * tags it as a wellness user. Never touches email (it is unverified profile
 * data, set only through updateAccountIdentity).
 */
export async function loginWellnessAccount(
  phone10: string,
  opts?: { name?: string },
): Promise<{ account: Account; created: boolean }> {
  const existing = await findAccountByPhone(phone10);
  if (existing?.status === "blocked") throw new AccountBlockedError("This account is blocked.");

  await ensureIdentityIndexes();
  const phoneE164 = toE164(phone10);
  let result;
  try {
    result = await upsertWellnessAccount(phoneE164);
  } catch (err) {
    // Two first-time logins for one phone: both upserts insert, the unique
    // index rejects one, and its retry now matches the winner's document.
    if (!isDuplicateKey(err, "phoneE164")) throw err;
    result = await upsertWellnessAccount(phoneE164);
  }
  if (!result.value) throw new Error("Account upsert returned no document.");
  // Blocked between the check above and the upsert.
  if (result.value.status === "blocked") throw new AccountBlockedError("This account is blocked.");

  const account = await setNameIfMissing(result.value, opts?.name);
  return { account, created: Boolean(result.lastErrorObject?.upserted) };
}

/** Profile edits to the shared identity. An empty email removes it (never stored as ""). */
export async function updateAccountIdentity(
  id: string,
  patch: { name?: string; email?: string | null },
): Promise<Account> {
  const _id = toObjectId(id);
  if (!_id) throw new Error("Account not found.");

  const $set: Partial<Account> = { updatedAt: new Date() };
  if (patch.name !== undefined) $set.name = patch.name;
  const email = patch.email?.trim().toLowerCase();
  if (email) $set.email = email;
  const clearEmail = patch.email !== undefined && !email;

  await ensureIdentityIndexes();
  let account;
  try {
    account = await usersCollection().findOneAndUpdate(
      { _id },
      clearEmail ? { $set, $unset: { email: "" } } : { $set },
      { returnDocument: "after" },
    );
  } catch (err) {
    if (isDuplicateKey(err, "email")) throw new EmailTakenError("This email is already in use.");
    throw err;
  }
  if (!account) throw new Error("Account not found.");
  return account;
}
