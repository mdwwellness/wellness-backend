import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import type { Request, Response } from "express";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ObjectId } from "mongodb";

const m = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  tooManyRequests: vi.fn(),
  isOtpConfigured: vi.fn(),
  sendOtp: vi.fn(),
  verifyOtp: vi.fn(),
  loginWellnessAccount: vi.fn(),
  updateAccountIdentity: vi.fn(),
  findAccountById: vi.fn(),
  findCustomerForAccount: vi.fn(),
  linkCustomerForAccount: vi.fn(),
  validateProfilePatch: vi.fn(),
  applyWellnessPatch: vi.fn(),
  setProfilePhoto: vi.fn(),
  toProfile: vi.fn(),
  listBookingsForPhone: vi.fn(),
  validateBookingRequest: vi.fn(),
  createBookingForCustomer: vi.fn(),
  isUploadConfigured: vi.fn(),
  uploadBuffer: vi.fn(),
  deleteUploadedFile: vi.fn(),
}));

vi.mock("../lib/logger.ts", () => ({ logger: m.logger }));
vi.mock("../lib/rateLimit.ts", () => ({
  tooManyRequests: m.tooManyRequests,
  clientIp: () => "203.0.113.7",
}));
// Real error classes, so the controller's instanceof checks are exercised.
vi.mock("../lib/msg91.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/msg91.ts")>()),
  isOtpConfigured: m.isOtpConfigured,
  sendOtp: m.sendOtp,
  verifyOtp: m.verifyOtp,
}));
vi.mock("../lib/customerAccount.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/customerAccount.ts")>()),
  loginWellnessAccount: m.loginWellnessAccount,
  updateAccountIdentity: m.updateAccountIdentity,
  findAccountById: m.findAccountById,
}));
vi.mock("../lib/customerProfile.ts", () => ({
  findCustomerForAccount: m.findCustomerForAccount,
  linkCustomerForAccount: m.linkCustomerForAccount,
  validateProfilePatch: m.validateProfilePatch,
  applyWellnessPatch: m.applyWellnessPatch,
  setProfilePhoto: m.setProfilePhoto,
  toProfile: m.toProfile,
}));
vi.mock("../lib/customerBookings.ts", () => ({
  listBookingsForPhone: m.listBookingsForPhone,
  validateBookingRequest: m.validateBookingRequest,
  createBookingForCustomer: m.createBookingForCustomer,
}));
vi.mock("../lib/uploadthing.ts", () => ({
  isUploadConfigured: m.isUploadConfigured,
  uploadBuffer: m.uploadBuffer,
  deleteUploadedFile: m.deleteUploadedFile,
}));

import {
  createMyBooking,
  getMyProfile,
  limitPhotoUploads,
  listMyBookings,
  sendLoginOtp,
  updateMyProfile,
  uploadMyPhoto,
  verifyLoginOtp,
} from "./customerAppController.ts";
import customerAppRouter, { warnIfCustomerAppUnconfigured } from "../routes/customerAppRoutes.ts";
import { errorHandler } from "../lib/httpErrors.ts";
import { OtpNotConfiguredError, OtpProviderError } from "../lib/msg91.ts";
import { AccountBlockedError, EmailTakenError } from "../lib/customerAccount.ts";
import { signCustomerToken, verifyCustomerToken } from "../lib/customerToken.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ACCOUNT_ID = "64b7f0c2a1b2c3d4e5f60718";
const PHONE = "9876543210";
const CUSTOMER_SECRET = "customer-secret-0123456789abcdef-xyz";
const JPEG = Buffer.from("\xff\xd8\xff\xe0\x00\x10JFIF", "latin1");

function account(overrides: Record<string, unknown> = {}) {
  return {
    _id: new ObjectId(ACCOUNT_ID),
    phoneE164: `+91${PHONE}`,
    roles: ["customer"],
    status: "active",
    products: ["wellness"],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const customer = (overrides: Record<string, unknown> = {}) => ({
  customer_id: "CUST-0074",
  name: "Asha Verma",
  email: "",
  address: "12 Lake Road",
  city: "Kolkata",
  pincode: "700091",
  ...overrides,
});

function mockReq(body?: unknown, extra: Record<string, unknown> = {}) {
  return { body, headers: {}, ...extra } as unknown as Request;
}

const authed = (body?: unknown, acct = account(), extra: Record<string, unknown> = {}) =>
  mockReq(body, { customerAccount: acct, ...extra });

// req.is() for a request sent with this Content-Type.
const photoReq = (body: unknown, contentType: string, acct = account()) =>
  authed(body, acct, { is: (t: string) => (t === contentType ? t : false) });

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

async function call(handler: (req: Request, res: Response) => unknown, req: Request) {
  const res = mockRes();
  await handler(req, res);
  return res;
}

function expectFail(res: ReturnType<typeof mockRes>, status: number, message: string) {
  expect(res.status).toHaveBeenCalledWith(status);
  expect(res.json).toHaveBeenCalledWith({ success: false, message });
}

const original = {
  JWT_SECRET: process.env.JWT_SECRET,
  CUSTOMER_JWT_SECRET: process.env.CUSTOMER_JWT_SECRET,
};

function restore(name: keyof typeof original) {
  if (original[name] === undefined) delete process.env[name];
  else process.env[name] = original[name];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = "staff-secret";
  process.env.CUSTOMER_JWT_SECRET = CUSTOMER_SECRET;
  m.tooManyRequests.mockReturnValue(false);
  m.isOtpConfigured.mockReturnValue(true);
  m.isUploadConfigured.mockReturnValue(true);
  m.toProfile.mockImplementation((acct, cust) => ({
    accountId: String(acct._id),
    customerId: cust?.customer_id ?? null,
  }));
});

afterEach(() => {
  restore("JWT_SECRET");
  restore("CUSTOMER_JWT_SECRET");
});

describe("POST /auth/otp", () => {
  it("400s on a missing or invalid phone without sending anything", async () => {
    for (const body of [undefined, {}, { phone: "12345" }, { phone: "5876543210" }]) {
      expectFail(await call(sendLoginOtp, mockReq(body)), 400, "Enter a valid 10-digit Indian mobile number.");
    }
    expect(m.sendOtp).not.toHaveBeenCalled();
  });

  it("503s when MSG91 isn't configured", async () => {
    m.isOtpConfigured.mockReturnValue(false);
    expectFail(await call(sendLoginOtp, mockReq({ phone: PHONE })), 503, "Phone sign-in isn't available right now.");
    expect(m.sendOtp).not.toHaveBeenCalled();
  });

  it("checks the IP, phone and global hourly limits", async () => {
    await call(sendLoginOtp, mockReq({ phone: PHONE }));
    expect(m.tooManyRequests.mock.calls).toEqual([
      ["cotp:ip:203.0.113.7", 20, HOUR],
      [`cotp:phone:${PHONE}`, 5, HOUR],
      ["cotp:global", 300, HOUR],
    ]);
  });

  it("429s when a limit is hit, and a refused request doesn't use the global budget", async () => {
    m.tooManyRequests.mockImplementation((key: string) => key.startsWith("cotp:phone:"));
    const res = await call(sendLoginOtp, mockReq({ phone: PHONE }));
    expectFail(res, 429, "Too many OTP requests. Please try again later.");
    expect(m.tooManyRequests).not.toHaveBeenCalledWith("cotp:global", 300, HOUR);
    expect(m.sendOtp).not.toHaveBeenCalled();
  });

  it("sends to the normalised 10-digit phone", async () => {
    const res = await call(sendLoginOtp, mockReq({ phone: "+91 98765 43210" }));
    expect(m.sendOtp).toHaveBeenCalledWith(PHONE);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, message: "OTP sent." });
  });

  it("maps provider errors to 503 / 502 and lets anything else reach the error handler", async () => {
    m.sendOtp.mockRejectedValueOnce(new OtpNotConfiguredError("x"));
    expectFail(await call(sendLoginOtp, mockReq({ phone: PHONE })), 503, "Phone sign-in isn't available right now.");

    m.sendOtp.mockRejectedValueOnce(new OtpProviderError("x"));
    expectFail(
      await call(sendLoginOtp, mockReq({ phone: PHONE })),
      502,
      "Couldn't send the OTP right now. Please try again.",
    );

    m.sendOtp.mockRejectedValueOnce(new Error("boom"));
    await expect(call(sendLoginOtp, mockReq({ phone: PHONE }))).rejects.toThrow("boom");
  });
});

describe("POST /auth/verify", () => {
  const body = (extra: Record<string, unknown> = {}) => ({ phone: PHONE, otp: "123456", ...extra });

  it("400s on a bad phone or a malformed OTP before calling MSG91", async () => {
    expectFail(await call(verifyLoginOtp, mockReq(body({ phone: "1" }))), 400, "Enter a valid 10-digit Indian mobile number.");
    // "1234" matters: MSG91's default length, which the patient site still sends.
    for (const otp of [undefined, 123456, "12a456", "123", "1234", "12345", "1234567", "123456789"]) {
      expectFail(await call(verifyLoginOtp, mockReq(body({ otp }))), 400, "Enter the OTP you received.");
    }
    expect(m.verifyOtp).not.toHaveBeenCalled();
  });

  it("limits attempts per IP first (30 an hour), then per phone: 10 an hour, 30 a day", async () => {
    m.verifyOtp.mockResolvedValue(false);
    await call(verifyLoginOtp, mockReq(body()));
    expect(m.tooManyRequests.mock.calls).toEqual([
      ["cverify:ip:203.0.113.7", 30, HOUR],
      [`cverify:phone:${PHONE}`, 10, HOUR],
      [`cverify:day:${PHONE}`, 30, DAY],
    ]);

    // An IP over its limit never creates phone-keyed buckets.
    vi.clearAllMocks();
    m.tooManyRequests.mockImplementation((key: string) => key.startsWith("cverify:ip:"));
    expectFail(await call(verifyLoginOtp, mockReq(body())), 429, "Too many attempts. Please try again later.");
    expect(m.tooManyRequests.mock.calls).toHaveLength(1);

    for (const scope of ["cverify:phone:", "cverify:day:"]) {
      vi.clearAllMocks();
      m.tooManyRequests.mockImplementation((key: string) => key.startsWith(scope));
      expectFail(await call(verifyLoginOtp, mockReq(body())), 429, "Too many attempts. Please try again later.");
      expect(m.verifyOtp).not.toHaveBeenCalled();
    }
  });

  it("503s when MSG91 isn't configured", async () => {
    m.isOtpConfigured.mockReturnValue(false);
    expectFail(await call(verifyLoginOtp, mockReq(body())), 503, "Phone sign-in isn't available right now.");
  });

  it("400s on a wrong or expired OTP without touching the account", async () => {
    m.verifyOtp.mockResolvedValue(false);
    expectFail(await call(verifyLoginOtp, mockReq(body())), 400, "Invalid or expired OTP.");
    expect(m.loginWellnessAccount).not.toHaveBeenCalled();
  });

  it("maps provider errors to 502 / 503", async () => {
    m.verifyOtp.mockRejectedValueOnce(new OtpProviderError("x"));
    expectFail(
      await call(verifyLoginOtp, mockReq(body())),
      502,
      "Couldn't verify the OTP right now. Please try again.",
    );
    m.verifyOtp.mockRejectedValueOnce(new OtpNotConfiguredError("x"));
    expectFail(await call(verifyLoginOtp, mockReq(body())), 503, "Phone sign-in isn't available right now.");
  });

  it("403s a blocked account", async () => {
    m.verifyOtp.mockResolvedValue(true);
    m.loginWellnessAccount.mockRejectedValue(new AccountBlockedError("blocked"));
    expectFail(await call(verifyLoginOtp, mockReq(body())), 403, "This account is blocked.");
    expect(m.linkCustomerForAccount).not.toHaveBeenCalled();
  });

  it("signs in: a real customer token, the new-account flag and the profile", async () => {
    const acct = account({ name: "Asha" });
    m.verifyOtp.mockResolvedValue(true);
    m.loginWellnessAccount.mockResolvedValue({ account: acct, created: true });
    m.linkCustomerForAccount.mockResolvedValue(customer());

    const res = await call(verifyLoginOtp, mockReq(body({ name: "  Asha " })));

    expect(m.verifyOtp).toHaveBeenCalledWith(PHONE, "123456");
    expect(m.loginWellnessAccount).toHaveBeenCalledWith(PHONE, { name: "Asha" });
    expect(m.linkCustomerForAccount).toHaveBeenCalledWith(acct);
    expect(m.toProfile).toHaveBeenCalledWith(acct, customer());
    expect(res.status).toHaveBeenCalledWith(200);
    const sent = res.json.mock.calls[0][0];
    expect(sent).toMatchObject({
      success: true,
      message: "Signed in.",
      data: {
        expiresIn: 7 * 24 * 60 * 60,
        isNewAccount: true,
        profile: { accountId: ACCOUNT_ID, customerId: "CUST-0074" },
      },
    });
    expect(verifyCustomerToken(sent.data.token)).toEqual({ ok: true, accountId: ACCOUNT_ID });
  });

  it("400s a name that isn't 2-80 characters before calling MSG91", async () => {
    for (const name of [{ $set: "x" }, 42, "", "   ", "A", "x".repeat(81)]) {
      expectFail(
        await call(verifyLoginOtp, mockReq(body({ name }))),
        400,
        "Enter your name (2-80 characters).",
      );
    }
    expect(m.tooManyRequests).not.toHaveBeenCalled();
    expect(m.verifyOtp).not.toHaveBeenCalled();
  });

  it("treats a missing or null name as not given", async () => {
    m.verifyOtp.mockResolvedValue(true);
    m.loginWellnessAccount.mockResolvedValue({ account: account(), created: false });
    for (const extra of [{}, { name: null }]) {
      await call(verifyLoginOtp, mockReq(body(extra)));
      expect(m.loginWellnessAccount).toHaveBeenLastCalledWith(PHONE, { name: undefined });
    }
  });

  it("still signs in when linking the clinic record fails, and logs no phone", async () => {
    const acct = account({ name: "Asha" });
    m.verifyOtp.mockResolvedValue(true);
    m.loginWellnessAccount.mockResolvedValue({ account: acct, created: false });
    // A Mongoose cast error quotes the value it rejected.
    m.linkCustomerForAccount.mockRejectedValue(new Error(`Cast to Number failed for value "${PHONE}x"`));

    const res = await call(verifyLoginOtp, mockReq(body()));

    expect(res.status).toHaveBeenCalledWith(200);
    expect(m.toProfile).toHaveBeenCalledWith(acct, null);
    expect(m.logger.error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(m.logger.error.mock.calls);
    expect(logged).not.toContain(PHONE);
    expect(logged).toContain("******3210");
  });
});

describe("GET /me", () => {
  it("returns the profile built from the account and its linked record", async () => {
    m.findCustomerForAccount.mockResolvedValue(customer());
    const acct = account({ name: "Asha", email: "a@x.com" });
    const res = await call(getMyProfile, authed(undefined, acct));
    expect(m.findCustomerForAccount).toHaveBeenCalledWith(acct);
    expect(m.toProfile).toHaveBeenCalledWith(acct, customer());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { accountId: ACCOUNT_ID, customerId: "CUST-0074" },
    });
  });
});

describe("PATCH /me", () => {
  const patch = (identity: object, wellness: object = {}) =>
    m.validateProfilePatch.mockReturnValue({ ok: true, patch: { identity, wellness } });

  it("400s with the validator's message and writes nothing", async () => {
    m.validateProfilePatch.mockReturnValue({ ok: false, message: "Phone can't be changed here." });
    expectFail(await call(updateMyProfile, authed({ phone: "1" })), 400, "Phone can't be changed here.");
    expect(m.updateAccountIdentity).not.toHaveBeenCalled();
    expect(m.linkCustomerForAccount).not.toHaveBeenCalled();
  });

  it("limits each account to 20 profile updates an hour, before any write", async () => {
    patch({ email: "a@x.com" });
    m.tooManyRequests.mockReturnValue(true);
    expectFail(await call(updateMyProfile, authed({})), 429, "Too many profile updates. Please try again later.");
    expect(m.tooManyRequests).toHaveBeenCalledWith(`cprofile:${ACCOUNT_ID}`, 20, HOUR);
    expect(m.updateAccountIdentity).not.toHaveBeenCalled();
    expect(m.linkCustomerForAccount).not.toHaveBeenCalled();
  });

  it("400s wellness fields when there is no name anywhere, before any write", async () => {
    patch({ email: "a@x.com" }, { gender: "female" });
    expectFail(await call(updateMyProfile, authed({})), 400, "Add your name before the other details.");
    expect(m.updateAccountIdentity).not.toHaveBeenCalled();
    expect(m.applyWellnessPatch).not.toHaveBeenCalled();
  });

  it("409s when the email belongs to another account", async () => {
    patch({ email: "taken@x.com" });
    m.updateAccountIdentity.mockRejectedValue(new EmailTakenError("x"));
    expectFail(await call(updateMyProfile, authed({})), 409, "That email is already used by another account.");
  });

  it("first save with a name: renames the account, links the record, applies the wellness fields", async () => {
    patch({ name: "Asha Verma" }, { gender: "female", city: "Kolkata" });
    m.updateAccountIdentity.mockResolvedValue(account({ name: "Asha Verma" }));
    m.linkCustomerForAccount.mockResolvedValue(customer());
    m.findCustomerForAccount.mockResolvedValue(customer({ gender: "female" }));

    const res = await call(updateMyProfile, authed({}));

    expect(m.updateAccountIdentity).toHaveBeenCalledWith(ACCOUNT_ID, { name: "Asha Verma" });
    expect(m.linkCustomerForAccount).toHaveBeenCalledWith(expect.objectContaining({ name: "Asha Verma" }));
    expect(m.applyWellnessPatch).toHaveBeenCalledWith(
      "CUST-0074",
      { gender: "female", city: "Kolkata" },
      undefined,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: "Profile updated.",
      data: { accountId: ACCOUNT_ID, customerId: "CUST-0074" },
    });
  });

  it("syncs a changed email to the linked record", async () => {
    patch({ email: "new@x.com" });
    m.updateAccountIdentity.mockResolvedValue(account({ name: "Asha", email: "new@x.com" }));
    m.linkCustomerForAccount.mockResolvedValue(customer());
    await call(updateMyProfile, authed({}, account({ name: "Asha" })));
    expect(m.applyWellnessPatch).toHaveBeenCalledWith("CUST-0074", {}, "new@x.com");
  });

  it("saves identity-only edits even without a clinic record", async () => {
    patch({ email: null });
    m.updateAccountIdentity.mockResolvedValue(account());
    m.linkCustomerForAccount.mockResolvedValue(null);
    const res = await call(updateMyProfile, authed({}));
    expect(m.updateAccountIdentity).toHaveBeenCalledWith(ACCOUNT_ID, { email: null });
    expect(m.applyWellnessPatch).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("skips the account write for wellness-only edits", async () => {
    patch({}, { pincode: "700091" });
    m.linkCustomerForAccount.mockResolvedValue(customer());
    await call(updateMyProfile, authed({}, account({ name: "Asha" })));
    expect(m.updateAccountIdentity).not.toHaveBeenCalled();
    expect(m.applyWellnessPatch).toHaveBeenCalledWith("CUST-0074", { pincode: "700091" }, undefined);
  });

  it("409s wellness fields when the named account's clinic record belongs to another login", async () => {
    patch({}, { gender: "male" });
    m.linkCustomerForAccount.mockResolvedValue(null);
    expectFail(
      await call(updateMyProfile, authed({}, account({ name: "Asha" }))),
      409,
      "Your clinic record is linked to another login. Please contact us.",
    );
    expect(m.applyWellnessPatch).not.toHaveBeenCalled();
  });
});

describe("PUT /me/photo", () => {
  beforeEach(() => {
    m.linkCustomerForAccount.mockResolvedValue(customer());
    m.uploadBuffer.mockResolvedValue("https://utfs.io/f/abc");
  });

  it("415s when the body wasn't parsed as an image", async () => {
    for (const body of [undefined, { photo: "x" }]) {
      expectFail(
        await call(uploadMyPhoto, photoReq(body, "application/json")),
        415,
        "Send the photo as image/jpeg, image/png or image/webp.",
      );
    }
  });

  it("400s an empty photo", async () => {
    expectFail(await call(uploadMyPhoto, photoReq(Buffer.alloc(0), "image/jpeg")), 400, "The photo is empty.");
  });

  it("400s a fake signature or one that doesn't match the Content-Type", async () => {
    expectFail(
      await call(uploadMyPhoto, photoReq(Buffer.from("<svg/>"), "image/png")),
      400,
      "That file isn't a valid image.",
    );
    expectFail(await call(uploadMyPhoto, photoReq(JPEG, "image/png")), 400, "That file isn't a valid image.");
    expect(m.uploadBuffer).not.toHaveBeenCalled();
  });

  it("400s when there is no clinic record (no name yet)", async () => {
    m.linkCustomerForAccount.mockResolvedValue(null);
    expectFail(
      await call(uploadMyPhoto, photoReq(JPEG, "image/jpeg")),
      400,
      "Add your name before uploading a photo.",
    );
    expect(m.uploadBuffer).not.toHaveBeenCalled();
  });

  it("409s when the named account's clinic record belongs to another login", async () => {
    m.linkCustomerForAccount.mockResolvedValue(null);
    expectFail(
      await call(uploadMyPhoto, photoReq(JPEG, "image/jpeg", account({ name: "Asha" }))),
      409,
      "Your clinic record is linked to another login. Please contact us.",
    );
    expect(m.uploadBuffer).not.toHaveBeenCalled();
  });

  it("503s when UploadThing isn't configured, before linking can create a record", async () => {
    m.isUploadConfigured.mockReturnValue(false);
    expectFail(await call(uploadMyPhoto, photoReq(JPEG, "image/jpeg")), 503, "Photo upload isn't available right now.");
    expect(m.linkCustomerForAccount).not.toHaveBeenCalled();
  });

  it("502s when UploadThing fails, and keeps the old photo", async () => {
    m.linkCustomerForAccount.mockResolvedValue(customer({ profilePhotoUrl: "https://utfs.io/f/old" }));
    m.uploadBuffer.mockRejectedValue(new Error("UploadThing upload failed"));
    expectFail(
      await call(uploadMyPhoto, photoReq(JPEG, "image/jpeg")),
      502,
      "Couldn't save the photo right now. Please try again.",
    );
    expect(m.setProfilePhoto).not.toHaveBeenCalled();
    expect(m.deleteUploadedFile).not.toHaveBeenCalled();
    expect(m.logger.error).toHaveBeenCalledTimes(1);
  });

  it("uploads under a server-generated name and stores the URL", async () => {
    const res = await call(uploadMyPhoto, photoReq(JPEG, "image/jpeg"));
    expect(m.uploadBuffer).toHaveBeenCalledWith({
      buffer: JPEG,
      filename: expect.stringMatching(/^customer-CUST-0074-\d+\.jpg$/),
      type: "image/jpeg",
    });
    expect(m.setProfilePhoto).toHaveBeenCalledWith("CUST-0074", "https://utfs.io/f/abc");
    expect(m.deleteUploadedFile).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("deletes the replaced photo only after the new URL is saved", async () => {
    m.linkCustomerForAccount.mockResolvedValue(customer({ profilePhotoUrl: "https://utfs.io/f/old" }));
    const res = await call(uploadMyPhoto, photoReq(JPEG, "image/jpeg"));
    expect(m.deleteUploadedFile).toHaveBeenCalledWith("https://utfs.io/f/old");
    expect(m.setProfilePhoto.mock.invocationCallOrder[0]).toBeLessThan(
      m.deleteUploadedFile.mock.invocationCallOrder[0],
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("limits each account to 5 uploads an hour", () => {
    const next = vi.fn();
    const res = mockRes();
    limitPhotoUploads(authed(), res, next);
    expect(m.tooManyRequests).toHaveBeenCalledWith(`cphoto:${ACCOUNT_ID}`, 5, HOUR);
    expect(next).toHaveBeenCalledTimes(1);

    m.tooManyRequests.mockReturnValue(true);
    const refused = mockRes();
    limitPhotoUploads(authed(), refused, next);
    expectFail(refused, 429, "Too many photo uploads. Please try again later.");
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("GET /bookings", () => {
  it("lists the bookings on the signed-in phone", async () => {
    m.listBookingsForPhone.mockResolvedValue([{ enquiryId: "ENQ-1" }]);
    const res = await call(listMyBookings, authed());
    expect(m.listBookingsForPhone).toHaveBeenCalledWith(PHONE);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: [{ enquiryId: "ENQ-1" }] });
  });
});

describe("POST /bookings", () => {
  const request = { service: "Home Therapy", note: "knee pain" };

  beforeEach(() => {
    m.validateBookingRequest.mockReturnValue({ ok: true, value: request });
    m.createBookingForCustomer.mockResolvedValue({ ok: true, enquiryId: "ENQ-0042", folded: false });
  });

  it("400s with the validator's message", async () => {
    m.validateBookingRequest.mockReturnValue({ ok: false, message: "Unknown field(s): quotedPrice." });
    expectFail(await call(createMyBooking, authed({ quotedPrice: 1 })), 400, "Unknown field(s): quotedPrice.");
    expect(m.createBookingForCustomer).not.toHaveBeenCalled();
  });

  it("limits each account to 10 bookings an hour", async () => {
    m.tooManyRequests.mockReturnValue(true);
    expectFail(await call(createMyBooking, authed(request)), 429, "Too many bookings. Please try again later.");
    expect(m.tooManyRequests).toHaveBeenCalledWith(`cbook:${ACCOUNT_ID}`, 10, HOUR);
    expect(m.createBookingForCustomer).not.toHaveBeenCalled();
  });

  it("400s when neither the account nor a clinic record has a name", async () => {
    m.linkCustomerForAccount.mockResolvedValue(null);
    expectFail(await call(createMyBooking, authed(request)), 400, "Add your name to your profile first.");
  });

  it("books under the clinic record's name and address, from the account's phone", async () => {
    m.linkCustomerForAccount.mockResolvedValue(customer());
    const res = await call(createMyBooking, authed(request, account({ name: "Asha V", email: "a@x.com" })));

    expect(m.createBookingForCustomer).toHaveBeenCalledWith(
      { phone10: PHONE, name: "Asha Verma", email: "a@x.com", defaultLocation: "12 Lake Road, Kolkata, 700091" },
      request,
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: "Booking received - our team will reach out shortly.",
      data: { enquiryId: "ENQ-0042", folded: false },
    });
  });

  it("falls back to the account name and skips empty address parts", async () => {
    m.linkCustomerForAccount.mockResolvedValueOnce(null);
    await call(createMyBooking, authed(request, account({ name: "Asha" })));
    expect(m.createBookingForCustomer).toHaveBeenLastCalledWith(
      { phone10: PHONE, name: "Asha", email: undefined, defaultLocation: undefined },
      request,
    );

    m.linkCustomerForAccount.mockResolvedValueOnce(customer({ address: "", pincode: undefined }));
    await call(createMyBooking, authed(request, account({ name: "Asha" })));
    expect(m.createBookingForCustomer.mock.lastCall?.[0].defaultLocation).toBe("Kolkata");
  });

  it("answers 200 when the request folded into an open enquiry", async () => {
    m.linkCustomerForAccount.mockResolvedValue(customer());
    m.createBookingForCustomer.mockResolvedValue({ ok: true, enquiryId: "ENQ-0041", folded: true });
    const res = await call(createMyBooking, authed(request));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: "We already have your enquiry - we've noted your latest details.",
      data: { enquiryId: "ENQ-0041", folded: true },
    });
  });

  it("passes a refusal through with its status", async () => {
    m.linkCustomerForAccount.mockResolvedValue(customer());
    m.createBookingForCustomer.mockResolvedValue({ ok: false, status: 409, message: "Slot taken." });
    expectFail(await call(createMyBooking, authed(request)), 409, "Slot taken.");
  });
});

// The router over real HTTP: the secret gate, real customerAuth, and the photo
// route's middleware order and body limits.
describe("customerAppRouter", () => {
  let server: Server;
  let base: string;
  const caught: any[] = [];

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/customer-app", customerAppRouter);
    // server.ts's own handler, with every error it sees recorded.
    app.use((err: any, req: Request, res: Response, next: express.NextFunction) => {
      caught.push(err);
      errorHandler(err, req, res, next);
    });
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/customer-app`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  beforeEach(() => {
    caught.length = 0;
    m.findAccountById.mockResolvedValue(account({ name: "Asha" }));
    m.linkCustomerForAccount.mockResolvedValue(customer());
    m.uploadBuffer.mockResolvedValue("https://utfs.io/f/abc");
  });

  const auth = () => ({ authorization: `Bearer ${signCustomerToken(ACCOUNT_ID)}` });
  const putPhoto = (body: Buffer | string, headers: Record<string, string>) =>
    fetch(`${base}/me/photo`, {
      method: "PUT",
      headers,
      body: typeof body === "string" ? body : new Uint8Array(body),
    });

  it("answers 503 on every route when the customer secret is missing or reused", async () => {
    delete process.env.CUSTOMER_JWT_SECRET;
    const otp = await fetch(`${base}/auth/otp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: PHONE }),
    });
    expect(otp.status).toBe(503);
    expect(await otp.json()).toEqual({ success: false, message: "Customer accounts aren't available right now." });
    expect(m.sendOtp).not.toHaveBeenCalled();

    process.env.CUSTOMER_JWT_SECRET = process.env.JWT_SECRET = CUSTOMER_SECRET;
    expect((await fetch(`${base}/me`)).status).toBe(503);
  });

  it("requires a customer token on the profile and booking routes", async () => {
    for (const [method, path] of [["GET", "/me"], ["PATCH", "/me"], ["GET", "/bookings"], ["POST", "/bookings"]]) {
      expect((await fetch(`${base}${path}`, { method })).status).toBe(401);
    }
  });

  it("rejects an anonymous photo before reading its body", async () => {
    const res = await putPhoto(Buffer.alloc(5 * 1024 * 1024), { "content-type": "image/jpeg" });
    expect(res.status).toBe(401);
    expect(caught).toEqual([]);
  });

  it("turns an oversized photo into a 413 from the body parser", async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(4 * 1024 * 1024)]);
    const res = await putPhoto(big, { ...auth(), "content-type": "image/jpeg" });
    expect(res.status).toBe(413);
    expect(caught[0]).toMatchObject({ status: 413, expose: true });
    expect(m.uploadBuffer).not.toHaveBeenCalled();
  });

  it("refuses a rate-limited photo before reading its body", async () => {
    m.tooManyRequests.mockImplementation((key: string) => key.startsWith("cphoto:"));
    const res = await putPhoto(Buffer.alloc(5 * 1024 * 1024), { ...auth(), "content-type": "image/jpeg" });
    expect(res.status).toBe(429);
    expect(caught).toEqual([]);
    expect(m.uploadBuffer).not.toHaveBeenCalled();
  });

  it("415s a photo sent with a non-image Content-Type", async () => {
    const res = await putPhoto(JSON.stringify({ photo: "x" }), { ...auth(), "content-type": "application/json" });
    expect(res.status).toBe(415);
  });

  it("uploads a valid photo end to end", async () => {
    const res = await putPhoto(JPEG, { ...auth(), "content-type": "image/jpeg" });
    expect(res.status).toBe(200);
    expect(m.uploadBuffer).toHaveBeenCalledWith(expect.objectContaining({ buffer: JPEG, type: "image/jpeg" }));
  });
});

describe("warnIfCustomerAppUnconfigured", () => {
  it("warns once per missing piece at boot", () => {
    delete process.env.CUSTOMER_JWT_SECRET;
    m.isOtpConfigured.mockReturnValue(false);
    warnIfCustomerAppUnconfigured();
    expect(m.logger.warn).toHaveBeenCalledTimes(2);
    expect(m.logger.warn.mock.calls[0][0]).toContain("CUSTOMER_JWT_SECRET");
    expect(m.logger.warn.mock.calls[1][0]).toContain("MSG91");
  });

  it("stays quiet when the app is configured", () => {
    warnIfCustomerAppUnconfigured();
    expect(m.logger.warn).not.toHaveBeenCalled();
  });
});
