import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ObjectId } from "mongodb";
import type { Account } from "./customerAccount.ts";

const { mockFindOne, mockUpdateOne, mockEnsure } = vi.hoisted(() => ({
  mockFindOne: vi.fn(),
  mockUpdateOne: vi.fn(),
  mockEnsure: vi.fn(),
}));
vi.mock("../models/customerModel.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../models/customerModel.ts")>()),
  default: { findOne: mockFindOne, updateOne: mockUpdateOne },
}));
vi.mock("./invoiceGeneration.ts", () => ({ ensureCustomerForAppointment: mockEnsure }));
vi.mock("./logger.ts", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  applyWellnessPatch,
  linkCustomerForAccount,
  setProfilePhoto,
  toProfile,
  validateProfilePatch,
} from "./customerProfile.ts";

const ID = "64b000000000000000000001";

function account(extra: Partial<Account> = {}): Account {
  return {
    _id: new ObjectId(ID),
    phoneE164: "+919876543210",
    roles: ["customer"],
    status: "active",
    products: ["wellness"],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...extra,
  };
}

const ACCT = account({ name: "Asha Verma" });
// A new login: the account exists but has no name yet.
const NO_NAME = account();

// "Now" is 2026-06-15 in India (IST, +05:30).
const setToday = (ymd: string) => vi.setSystemTime(new Date(`${ymd}T12:00:00+05:30`));

function patchError(body: unknown) {
  const r = validateProfilePatch(body);
  return r.ok ? null : r.message;
}

function patchOf(body: unknown) {
  const r = validateProfilePatch(body);
  if (!r.ok) throw new Error(r.message);
  return r.patch;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  setToday("2026-06-15");
});
afterEach(() => vi.useRealTimers());

describe("linkCustomerForAccount", () => {
  it("returns the record already linked to this login, without touching anything else", async () => {
    const linked = { customer_id: "CUST-0001", accountId: ID };
    mockFindOne.mockResolvedValue(linked);
    expect(await linkCustomerForAccount(ACCT)).toBe(linked);
    expect(mockFindOne).toHaveBeenCalledWith({ accountId: ID });
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it("creates nothing while the account has no name", async () => {
    mockFindOne.mockResolvedValue(null);
    expect(await linkCustomerForAccount(NO_NAME)).toBeNull();
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("links the phone + name match, claiming it only if no login owns it yet", async () => {
    const candidate = { _id: "c1", customer_id: "CUST-0007" };
    const claimed = { ...candidate, accountId: ID };
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(claimed);
    mockEnsure.mockResolvedValue(candidate);

    expect(await linkCustomerForAccount({ ...ACCT, email: "asha@example.com" })).toBe(claimed);
    expect(mockEnsure).toHaveBeenCalledWith({
      phonenumber: 9876543210,
      name: "Asha Verma",
      email: "asha@example.com",
    });
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: "c1", accountId: { $exists: false } },
      { $set: { accountId: ID } },
    );
  });

  it("never steals a record linked to another login", async () => {
    mockFindOne.mockResolvedValue(null);
    mockEnsure.mockResolvedValue({ _id: "c1", customer_id: "CUST-0007", accountId: "other" });
    mockUpdateOne.mockResolvedValue({ matchedCount: 0 });

    expect(await linkCustomerForAccount(ACCT)).toBeNull();
    // The guarded filter is what keeps the other login's link intact.
    expect(mockUpdateOne.mock.calls[0][0]).toEqual({ _id: "c1", accountId: { $exists: false } });
  });

  it("re-reads by accountId when a concurrent request won the link (duplicate key)", async () => {
    const winner = { customer_id: "CUST-0009", accountId: ID };
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    mockEnsure.mockResolvedValue({ _id: "c1", customer_id: "CUST-0007" });
    mockUpdateOne.mockRejectedValue(Object.assign(new Error("E11000"), { code: 11000 }));

    expect(await linkCustomerForAccount(ACCT)).toBe(winner);
  });

  it("rethrows any other database error", async () => {
    mockFindOne.mockResolvedValue(null);
    mockEnsure.mockResolvedValue({ _id: "c1" });
    mockUpdateOne.mockRejectedValue(new Error("connection lost"));
    await expect(linkCustomerForAccount(ACCT)).rejects.toThrow("connection lost");
  });
});

describe("validateProfilePatch: shape", () => {
  it("rejects an empty or non-object body", () => {
    for (const body of [{}, null, undefined, "x", 5, []]) {
      expect(patchError(body)).toBe("Nothing to update.");
    }
  });

  it("refuses phone changes", () => {
    expect(patchError({ phone: "9876543210" })).toBe("Phone can't be changed here.");
    expect(patchError({ name: "Asha", phonenumber: 9876543210 })).toBe("Phone can't be changed here.");
  });

  it("names every unknown field (mass assignment)", () => {
    expect(patchError({ name: "Asha", accountId: "x", customer_id: "CUST-1" })).toBe(
      "Unknown field(s): accountId, customer_id.",
    );
    expect(patchError(JSON.parse('{"__proto__": {"admin": true}}'))).toBe("Unknown field(s): __proto__.");
  });

  it("splits identity (account) from wellness (clinic record) fields", () => {
    expect(
      patchOf({
        name: "  Asha Verma ",
        email: " Asha@Example.COM ",
        gender: "female",
        dob: "1990-04-12",
        address: " 12 Lake Road ",
        city: "Kolkata",
        pincode: "700091",
        emergencyContact: { name: "Ravi", phone: "+91 98765 43211", relation: "Brother" },
      }),
    ).toEqual({
      identity: { name: "Asha Verma", email: "asha@example.com" },
      wellness: {
        gender: "female",
        dob: new Date("1990-04-12T00:00:00Z"),
        address: "12 Lake Road",
        city: "Kolkata",
        pincode: "700091",
        emergencyContact: { name: "Ravi", phone: 9876543211, relation: "Brother" },
      },
    });
  });

  it("includes only the fields that were sent", () => {
    expect(patchOf({ city: "Pune" })).toEqual({ identity: {}, wellness: { city: "Pune" } });
  });

  it("turns null (and blank where allowed) into a clear", () => {
    expect(
      patchOf({
        email: null,
        gender: null,
        dob: null,
        address: null,
        city: "  ",
        pincode: "",
        emergencyContact: null,
      }),
    ).toEqual({
      identity: { email: null },
      wellness: { gender: null, dob: null, address: null, city: null, pincode: null, emergencyContact: null },
    });
    expect(patchOf({ email: "" }).identity).toEqual({ email: null });
  });
});

describe("validateProfilePatch: field rules", () => {
  it("name: 2-80 characters after trimming, never null", () => {
    expect(patchError({ name: " A " })).toBe("Name must be 2-80 characters.");
    expect(patchError({ name: "x".repeat(81) })).toBe("Name must be 2-80 characters.");
    expect(patchError({ name: null })).toBe("Name must be 2-80 characters.");
    expect(patchError({ name: 42 })).toBe("Name must be 2-80 characters.");
    expect(patchOf({ name: "x".repeat(80) }).identity.name).toHaveLength(80);
  });

  it("email: simple shape check, max 254", () => {
    for (const email of ["nope", "a@b", "a b@c.de", 42, `${"a".repeat(250)}@b.co`]) {
      expect(patchError({ email })).toBe("Enter a valid email address.");
    }
  });

  it("gender: male, female or other", () => {
    for (const gender of ["Male", "x", "", 1]) {
      expect(patchError({ gender })).toBe("Gender must be male, female or other.");
    }
    expect(patchOf({ gender: "other" }).wellness.gender).toBe("other");
  });

  it("dob: a real YYYY-MM-DD date", () => {
    for (const dob of ["2023-02-30", "1990-13-01", "12-04-1990", "1990-4-12", "", 19900412]) {
      expect(patchError({ dob })).toBe("Date of birth must be a real date (YYYY-MM-DD).");
    }
    expect(patchOf({ dob: "2024-02-29" }).wellness.dob).toEqual(new Date("2024-02-29T00:00:00Z"));
  });

  it("dob: not in the future (Indian calendar date) and at most 120 years ago", () => {
    expect(patchError({ dob: "2026-06-16" })).toBe("Date of birth can't be in the future.");
    expect(patchOf({ dob: "2026-06-15" }).wellness.dob).toBeInstanceOf(Date);
    expect(patchError({ dob: "1906-06-14" })).toBe("Date of birth can't be more than 120 years ago.");
    expect(patchOf({ dob: "1906-06-15" }).wellness.dob).toBeInstanceOf(Date);

    // 00:30 IST on the 16th is still the 15th in UTC: India's date decides.
    vi.setSystemTime(new Date("2026-06-16T00:30:00+05:30"));
    expect(patchOf({ dob: "2026-06-16" }).wellness.dob).toBeInstanceOf(Date);
  });

  it("address max 200, city max 80, both text", () => {
    expect(patchError({ address: "x".repeat(201) })).toBe("Address must be at most 200 characters.");
    expect(patchError({ city: "x".repeat(81) })).toBe("City must be at most 80 characters.");
    expect(patchError({ city: 5 })).toBe("City must be text.");
  });

  it("pincode: 6 digits, not starting with 0", () => {
    for (const pincode of ["012345", "70009", "7000911", "70009a"]) {
      expect(patchError({ pincode })).toBe("Pincode must be 6 digits.");
    }
    expect(patchOf({ pincode: 700091 }).wellness.pincode).toBe("700091");
  });

  it("emergencyContact: name 2-80, Indian mobile, optional relation max 40, nothing else", () => {
    const ok = { name: "Ravi", phone: "9876543211" };
    expect(patchOf({ emergencyContact: ok }).wellness.emergencyContact).toEqual({
      name: "Ravi",
      phone: 9876543211,
    });
    expect(patchError({ emergencyContact: "Ravi" })).toBe("Emergency contact needs a name and phone.");
    expect(patchError({ emergencyContact: { ...ok, name: "R" } })).toBe(
      "Emergency contact name must be 2-80 characters.",
    );
    expect(patchError({ emergencyContact: { ...ok, phone: "12345" } })).toBe(
      "Emergency contact phone must be a valid Indian mobile number.",
    );
    expect(patchError({ emergencyContact: { ...ok, relation: "x".repeat(41) } })).toBe(
      "Relation must be at most 40 characters.",
    );
    expect(patchError({ emergencyContact: { ...ok, email: "r@x.in" } })).toBe(
      "Unknown emergency contact field(s): email.",
    );
  });
});

describe("applyWellnessPatch", () => {
  it("$sets values, $unsets nulls, and never sets the clinic record's name", async () => {
    const wellness = {
      gender: "female" as const,
      dob: null,
      city: "Kolkata",
      pincode: null,
      // Not a wellness field: must be ignored even if a caller slips it in.
      name: "Renamed",
    } as any;
    await applyWellnessPatch("CUST-0007", wellness);

    expect(mockUpdateOne).toHaveBeenCalledWith(
      { customer_id: "CUST-0007" },
      { $set: { gender: "female", city: "Kolkata" }, $unset: { dob: 1, pincode: 1 } },
    );
  });

  it("syncs the email (cleared email is stored as the dashboard's empty string)", async () => {
    await applyWellnessPatch("CUST-0007", {}, "asha@example.com");
    expect(mockUpdateOne).toHaveBeenLastCalledWith(
      { customer_id: "CUST-0007" },
      { $set: { email: "asha@example.com" } },
    );
    await applyWellnessPatch("CUST-0007", {}, null);
    expect(mockUpdateOne).toHaveBeenLastCalledWith({ customer_id: "CUST-0007" }, { $set: { email: "" } });
  });

  it("skips the write when there is nothing to change", async () => {
    await applyWellnessPatch("CUST-0007", {});
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it("refuses an empty customer id instead of matching any customer", async () => {
    await expect(applyWellnessPatch("", { city: "Pune" })).rejects.toThrow("customerId is required");
    await expect(setProfilePhoto("", "https://x")).rejects.toThrow("customerId is required");
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });
});

describe("setProfilePhoto", () => {
  it("stores the url on the clinic record", async () => {
    await setProfilePhoto("CUST-0007", "https://utfs.io/f/abc");
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { customer_id: "CUST-0007" },
      { $set: { profilePhotoUrl: "https://utfs.io/f/abc" } },
    );
  });
});

describe("toProfile", () => {
  const ageFor = (dob: string) => toProfile(ACCT, { dob: new Date(`${dob}T00:00:00Z`) }).age;

  it("counts completed years", () => {
    expect(ageFor("1990-06-15")).toBe(36); // birthday today
    expect(ageFor("1990-06-16")).toBe(35); // not yet this year
    expect(ageFor("1990-01-01")).toBe(36);
  });

  it("counts a 29 Feb birthday from 1 Mar in non-leap years", () => {
    setToday("2027-02-28");
    expect(ageFor("2000-02-29")).toBe(26);
    setToday("2027-03-01");
    expect(ageFor("2000-02-29")).toBe(27);
    setToday("2028-02-29");
    expect(ageFor("2000-02-29")).toBe(28);
  });

  it("uses India's date for the birthday", () => {
    // 00:30 IST on the birthday is still the day before in UTC.
    vi.setSystemTime(new Date("2026-06-16T00:30:00+05:30"));
    expect(ageFor("1990-06-16")).toBe(36);
  });

  it("maps a full record, preferring the account's name and email", () => {
    const customer = {
      customer_id: "CUST-0007",
      name: "ASHA V",
      email: "old@example.com",
      gender: "female",
      dob: new Date("1990-04-12T00:00:00Z"),
      address: "12 Lake Road",
      city: "Kolkata",
      pincode: "700091",
      emergencyContact: { name: "Ravi", phone: 9876543211, relation: "Brother" },
      profilePhotoUrl: "https://utfs.io/f/abc",
      notes: [{ note: "internal" }],
    };
    expect(toProfile({ ...ACCT, email: "asha@example.com" }, customer)).toEqual({
      accountId: ID,
      customerId: "CUST-0007",
      phone: "9876543210",
      name: "Asha Verma",
      email: "asha@example.com",
      gender: "female",
      dob: "1990-04-12",
      age: 36,
      address: "12 Lake Road",
      city: "Kolkata",
      pincode: "700091",
      emergencyContact: { name: "Ravi", phone: "9876543211", relation: "Brother" },
      profilePhotoUrl: "https://utfs.io/f/abc",
      profileComplete: true,
    });
  });

  it("is all nulls for a new login, and incomplete until the account has a name", () => {
    expect(toProfile(NO_NAME, null)).toEqual({
      accountId: ID,
      customerId: null,
      phone: "9876543210",
      name: null,
      email: null,
      gender: null,
      dob: null,
      age: null,
      address: null,
      city: null,
      pincode: null,
      emergencyContact: null,
      profilePhotoUrl: null,
      profileComplete: false,
    });
  });

  it("falls back to the clinic record's name but stays incomplete without an account name", () => {
    const p = toProfile(NO_NAME, { name: "Asha", address: "" });
    expect(p.name).toBe("Asha");
    expect(p.address).toBeNull();
    expect(p.profileComplete).toBe(false);
  });
});
