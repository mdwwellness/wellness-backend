import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";

const { col, mockUseDb } = vi.hoisted(() => {
  const col = { findOne: vi.fn(), findOneAndUpdate: vi.fn(), createIndex: vi.fn() };
  return { col, mockUseDb: vi.fn(() => ({ collection: () => col })) };
});
vi.mock("mongoose", () => ({ default: { connection: { useDb: mockUseDb } } }));

import {
  AccountBlockedError,
  EmailTakenError,
  findAccountById,
  loginWellnessAccount,
  updateAccountIdentity,
  validPersonName,
} from "./customerAccount.ts";

const PHONE = "9876543210";
const ID = new ObjectId();

function account(extra: Record<string, unknown> = {}) {
  return { _id: ID, phoneE164: "+91" + PHONE, roles: ["customer"], status: "active", ...extra };
}

// What findOneAndUpdate resolves to with includeResultMetadata: true.
function upsertResult(doc: object, inserted = false) {
  return { value: doc, ok: 1, lastErrorObject: inserted ? { upserted: ID } : { updatedExisting: true } };
}

const dupKey = (field: string) => Object.assign(new Error("E11000"), { code: 11000, keyPattern: { [field]: 1 } });

beforeEach(() => {
  vi.clearAllMocks();
  col.createIndex.mockResolvedValue("ok");
});

describe("validPersonName", () => {
  it("trims, then accepts 2-80 characters", () => {
    expect(validPersonName("  Asha Verma  ")).toBe("Asha Verma");
    expect(validPersonName("Al")).toBe("Al");
    expect(validPersonName("x".repeat(80))).toHaveLength(80);
  });

  it("rejects too short, too long and non-strings", () => {
    for (const input of [" A ", "", "x".repeat(81), null, undefined, 42, ["Asha"], {}]) {
      expect(validPersonName(input)).toBeNull();
    }
  });
});

describe("loginWellnessAccount", () => {
  it("rejects a blocked account before writing anything", async () => {
    col.findOne.mockResolvedValue(account({ status: "blocked" }));
    await expect(loginWellnessAccount(PHONE)).rejects.toBeInstanceOf(AccountBlockedError);
    expect(col.findOne).toHaveBeenCalledWith({ phoneE164: "+919876543210" });
    expect(col.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("creates a new account tagged wellness, in the patient site's shape", async () => {
    col.findOne.mockResolvedValue(null);
    col.findOneAndUpdate.mockResolvedValue(upsertResult(account({ products: ["wellness"] }), true));

    const { account: acct, created } = await loginWellnessAccount(PHONE);

    expect(created).toBe(true);
    expect(acct.products).toEqual(["wellness"]);
    const [filter, update, opts] = col.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ phoneE164: "+919876543210" });
    expect(update.$setOnInsert).toMatchObject({ phoneE164: "+919876543210", roles: ["customer"], status: "active" });
    expect(update.$setOnInsert.createdAt).toBeInstanceOf(Date);
    expect(update.$set.updatedAt).toBeInstanceOf(Date);
    expect(opts).toMatchObject({ upsert: true, returnDocument: "after" });
  });

  it("tags an existing account with $addToSet so the tag is never duplicated", async () => {
    col.findOne.mockResolvedValue(account());
    col.findOneAndUpdate.mockResolvedValue(upsertResult(account({ products: ["wellness"] })));

    const { created } = await loginWellnessAccount(PHONE);

    expect(created).toBe(false);
    const update = col.findOneAndUpdate.mock.calls[0][1];
    expect(update.$addToSet).toEqual({ products: "wellness" });
    expect(update.$push).toBeUndefined();
  });

  it("never touches email", async () => {
    col.findOne.mockResolvedValue(null);
    col.findOneAndUpdate
      .mockResolvedValueOnce(upsertResult(account(), true))
      .mockResolvedValueOnce(account({ name: "Asha" }));

    await loginWellnessAccount(PHONE, { name: "Asha" });

    for (const [, update] of col.findOneAndUpdate.mock.calls) {
      expect(JSON.stringify(update)).not.toContain("email");
    }
  });

  it("sets a trimmed name only when the account has none, guarded in the filter", async () => {
    col.findOne.mockResolvedValue(null);
    col.findOneAndUpdate
      .mockResolvedValueOnce(upsertResult(account(), true))
      .mockResolvedValueOnce(account({ name: "Asha Verma" }));

    const { account: acct } = await loginWellnessAccount(PHONE, { name: "  Asha Verma  " });

    expect(acct.name).toBe("Asha Verma");
    const [filter, update] = col.findOneAndUpdate.mock.calls[1];
    expect(filter).toEqual({ _id: ID, $or: [{ name: { $exists: false } }, { name: "" }] });
    expect(update.$set.name).toBe("Asha Verma");
  });

  it("never overwrites an existing name", async () => {
    col.findOne.mockResolvedValue(account({ name: "Old Name" }));
    col.findOneAndUpdate.mockResolvedValue(upsertResult(account({ name: "Old Name" })));

    const { account: acct } = await loginWellnessAccount(PHONE, { name: "New Name" });

    expect(acct.name).toBe("Old Name");
    expect(col.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("keeps the name a concurrent login set first (guard did not match)", async () => {
    col.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(account({ name: "Winner" }));
    col.findOneAndUpdate.mockResolvedValueOnce(upsertResult(account(), true)).mockResolvedValueOnce(null);

    const { account: acct } = await loginWellnessAccount(PHONE, { name: "Loser" });

    expect(acct.name).toBe("Winner");
  });

  it("ignores a name outside 2-80 characters", async () => {
    col.findOne.mockResolvedValue(null);
    col.findOneAndUpdate.mockResolvedValue(upsertResult(account(), true));

    for (const name of [" A ", "x".repeat(81)]) await loginWellnessAccount(PHONE, { name });

    expect(col.findOneAndUpdate).toHaveBeenCalledTimes(2); // the two upserts, no name writes
  });

  it("retries once when a concurrent first login wins the phone race", async () => {
    col.findOne.mockResolvedValue(null);
    col.findOneAndUpdate
      .mockRejectedValueOnce(dupKey("phoneE164"))
      .mockResolvedValueOnce(upsertResult(account({ products: ["wellness"] })));

    const { created } = await loginWellnessAccount(PHONE);

    expect(created).toBe(false);
    expect(col.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it("retries only once, and never on other errors", async () => {
    col.findOne.mockResolvedValue(null);
    col.findOneAndUpdate.mockRejectedValue(dupKey("phoneE164"));
    await expect(loginWellnessAccount(PHONE)).rejects.toMatchObject({ code: 11000 });
    expect(col.findOneAndUpdate).toHaveBeenCalledTimes(2);

    col.findOneAndUpdate.mockReset().mockRejectedValue(new Error("network"));
    await expect(loginWellnessAccount(PHONE)).rejects.toThrow("network");
    expect(col.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("rejects an account blocked between the check and the upsert", async () => {
    col.findOne.mockResolvedValue(account());
    col.findOneAndUpdate.mockResolvedValue(upsertResult(account({ status: "blocked" })));
    await expect(loginWellnessAccount(PHONE)).rejects.toBeInstanceOf(AccountBlockedError);
  });
});

describe("updateAccountIdentity", () => {
  it("stores email trimmed and lowercased", async () => {
    col.findOneAndUpdate.mockResolvedValue(account({ email: "asha@example.com" }));

    await updateAccountIdentity(ID.toHexString(), { email: "  Asha@Example.COM " });

    const [filter, update] = col.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: ID });
    expect(update.$set.email).toBe("asha@example.com");
    expect(update.$unset).toBeUndefined();
  });

  it("unsets email for \"\" or null, never storing an empty string", async () => {
    col.findOneAndUpdate.mockResolvedValue(account());
    for (const email of ["", "   ", null]) {
      col.findOneAndUpdate.mockClear();
      await updateAccountIdentity(ID.toHexString(), { email });
      const update = col.findOneAndUpdate.mock.calls[0][1];
      expect(update.$unset).toEqual({ email: "" });
      expect(update.$set).not.toHaveProperty("email");
    }
  });

  it("sets the name and leaves email alone when email is not in the patch", async () => {
    col.findOneAndUpdate.mockResolvedValue(account({ name: "Asha" }));
    await updateAccountIdentity(ID.toHexString(), { name: "Asha" });
    const update = col.findOneAndUpdate.mock.calls[0][1];
    expect(update.$set.name).toBe("Asha");
    expect(update.$set).not.toHaveProperty("email");
    expect(update.$unset).toBeUndefined();
  });

  it("maps a duplicate email to EmailTakenError", async () => {
    col.findOneAndUpdate.mockRejectedValue(dupKey("email"));
    await expect(updateAccountIdentity(ID.toHexString(), { email: "taken@example.com" })).rejects.toBeInstanceOf(
      EmailTakenError,
    );
  });

  it("throws for an unknown account", async () => {
    col.findOneAndUpdate.mockResolvedValue(null);
    await expect(updateAccountIdentity(ID.toHexString(), { name: "Asha" })).rejects.toThrow("Account not found.");
    await expect(updateAccountIdentity("nope", { name: "Asha" })).rejects.toThrow("Account not found.");
  });
});

describe("findAccountById", () => {
  it("returns null for a malformed id without querying", async () => {
    for (const id of ["", "abc", "z".repeat(24), "aaaaaaaaaaaa", 123, null, ["a".repeat(24)]]) {
      expect(await findAccountById(id as string)).toBeNull();
    }
    expect(col.findOne).not.toHaveBeenCalled();
  });

  it("looks up a valid id as an ObjectId in the identity db", async () => {
    col.findOne.mockResolvedValue(account());
    expect(await findAccountById(ID.toHexString())).toMatchObject({ _id: ID });
    expect(col.findOne).toHaveBeenCalledWith({ _id: ID });
    expect(mockUseDb).toHaveBeenCalledWith("mdw", { useCache: true });
  });
});

describe("ensureIdentityIndexes", () => {
  it("creates the patient site's indexes once, and retries after a failure", async () => {
    vi.resetModules();
    const { ensureIdentityIndexes } = await import("./customerAccount.ts");

    col.createIndex.mockRejectedValueOnce(new Error("down"));
    await expect(ensureIdentityIndexes()).rejects.toThrow("down");

    col.createIndex.mockClear();
    await ensureIdentityIndexes();
    await ensureIdentityIndexes();
    expect(col.createIndex).toHaveBeenCalledTimes(2);
    expect(col.createIndex).toHaveBeenCalledWith({ phoneE164: 1 }, { unique: true });
    expect(col.createIndex).toHaveBeenCalledWith({ email: 1 }, { unique: true, sparse: true });
  });
});
