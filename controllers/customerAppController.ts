import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger.ts";
import { redactDigits } from "../lib/httpErrors.ts";
import { fromE164, parseIndianMobile } from "../lib/phone.ts";
import { clientIp, tooManyRequests } from "../lib/rateLimit.ts";
import {
  isOtpConfigured,
  OtpNotConfiguredError,
  OtpProviderError,
  sendOtp,
  verifyOtp,
} from "../lib/msg91.ts";
import { CUSTOMER_TOKEN_TTL_SECONDS, signCustomerToken } from "../lib/customerToken.ts";
import {
  AccountBlockedError,
  EmailTakenError,
  loginWellnessAccount,
  updateAccountIdentity,
  validPersonName,
} from "../lib/customerAccount.ts";
import type { Account } from "../lib/customerAccount.ts";
import {
  applyWellnessPatch,
  findCustomerForAccount,
  linkCustomerForAccount,
  setProfilePhoto,
  toProfile,
  validateProfilePatch,
} from "../lib/customerProfile.ts";
import {
  createBookingForCustomer,
  listBookingsForPhone,
  validateBookingRequest,
} from "../lib/customerBookings.ts";
import { deleteUploadedFile, isUploadConfigured, uploadBuffer } from "../lib/uploadthing.ts";
import { sniffImage } from "../lib/imageType.ts";

/**
 * Customers' App: phone-OTP sign-in, own profile, own bookings. Who the caller
 * is always comes from the verified phone or the token's account, never from
 * the request body (phone, name, email, accountId, customer_id are not read).
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const BAD_PHONE = "Enter a valid 10-digit Indian mobile number.";
const OTP_UNAVAILABLE = "Phone sign-in isn't available right now.";

const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({ success: false, message });

async function profileOf(account: Account) {
  return toProfile(account, await findCustomerForAccount(account));
}

// linkCustomerForAccount only returns null for a named account when its
// phone + name record already belongs to another login; asking for a name
// then would send the customer in circles.
function noClinicRecord(res: Response, account: Account, nameMessage: string) {
  if (account.name) {
    return fail(res, 409, "Your clinic record is linked to another login. Please contact us.");
  }
  return fail(res, 400, nameMessage);
}

function otpFailure(res: Response, err: unknown, providerMessage: string) {
  if (err instanceof OtpNotConfiguredError) return fail(res, 503, OTP_UNAVAILABLE);
  if (err instanceof OtpProviderError) return fail(res, 502, providerMessage);
  throw err;
}

// customerAuth has already loaded and checked the account.
const signedIn = (req: Request) => req.customerAccount as Account;

export const sendLoginOtp = async (req: Request, res: Response) => {
  const phone = parseIndianMobile(req.body?.phone);
  if (!phone) return fail(res, 400, BAD_PHONE);
  if (!isOtpConfigured()) return fail(res, 503, OTP_UNAVAILABLE);
  // Every send is a paid SMS: per IP, per phone, then a global cap so rotating
  // IPs and numbers still can't run up the bill. Global last, so requests
  // already refused don't use up everyone's budget.
  if (
    tooManyRequests(`cotp:ip:${clientIp(req)}`, 20, HOUR_MS) ||
    tooManyRequests(`cotp:phone:${phone}`, 5, HOUR_MS) ||
    tooManyRequests("cotp:global", 300, HOUR_MS)
  ) {
    return fail(res, 429, "Too many OTP requests. Please try again later.");
  }

  try {
    await sendOtp(phone);
  } catch (err) {
    return otpFailure(res, err, "Couldn't send the OTP right now. Please try again.");
  }
  return res.status(200).json({ success: true, message: "OTP sent." });
};

export const verifyLoginOtp = async (req: Request, res: Response) => {
  const phone = parseIndianMobile(req.body?.phone);
  if (!phone) return fail(res, 400, BAD_PHONE);
  const otp = req.body?.otp;
  // Exactly 6: this backend only issues 6-digit codes, and accepting 4 would let
  // a code the patient site sent at MSG91's default length be guessed here.
  if (typeof otp !== "string" || !/^\d{6}$/.test(otp)) {
    return fail(res, 400, "Enter the OTP you received.");
  }
  // Checked before MSG91, so a bad name never uses up the OTP.
  const rawName = req.body.name;
  const name = rawName == null ? undefined : validPersonName(rawName);
  if (name === null) return fail(res, 400, "Enter your name (2-80 characters).");
  // Per IP first, so one client can't mint a fresh phone-keyed bucket per
  // request. The daily cap stops 10 guesses an hour adding up around the clock.
  if (
    tooManyRequests(`cverify:ip:${clientIp(req)}`, 30, HOUR_MS) ||
    tooManyRequests(`cverify:phone:${phone}`, 10, HOUR_MS) ||
    tooManyRequests(`cverify:day:${phone}`, 30, DAY_MS)
  ) {
    return fail(res, 429, "Too many attempts. Please try again later.");
  }
  if (!isOtpConfigured()) return fail(res, 503, OTP_UNAVAILABLE);

  let valid: boolean;
  try {
    valid = await verifyOtp(phone, otp);
  } catch (err) {
    return otpFailure(res, err, "Couldn't verify the OTP right now. Please try again.");
  }
  if (!valid) return fail(res, 400, "Invalid or expired OTP.");

  let login;
  try {
    login = await loginWellnessAccount(phone, { name });
  } catch (err) {
    if (err instanceof AccountBlockedError) return fail(res, 403, "This account is blocked.");
    throw err;
  }

  const { account } = login;
  // Sign-in must not fail over the clinic record: it is linked again on the
  // next profile save, photo or booking.
  const customer = await linkCustomerForAccount(account).catch((err) => {
    logger.error("Linking the customer record after sign-in failed", {
      accountId: String(account._id),
      error: redactDigits(err instanceof Error ? err.message : String(err)),
    });
    return null;
  });

  return res.status(200).json({
    success: true,
    message: "Signed in.",
    data: {
      token: signCustomerToken(String(account._id)),
      expiresIn: CUSTOMER_TOKEN_TTL_SECONDS,
      isNewAccount: login.created,
      profile: toProfile(account, customer),
    },
  });
};

export const getMyProfile = async (req: Request, res: Response) => {
  return res.status(200).json({ success: true, data: await profileOf(signedIn(req)) });
};

const NAME_FIRST = "Add your name before the other details.";

export const updateMyProfile = async (req: Request, res: Response) => {
  const result = validateProfilePatch(req.body);
  if (!result.ok) return fail(res, 400, result.message);
  const { identity, wellness } = result.patch;
  let account = signedIn(req);
  if (tooManyRequests(`cprofile:${account._id}`, 20, HOUR_MS)) {
    return fail(res, 429, "Too many profile updates. Please try again later.");
  }

  // Wellness details live on the clinic's customer record, which needs a name.
  // Checked before any write so this 400 never leaves an email half-saved.
  const needsRecord = Object.keys(wellness).length > 0;
  if (needsRecord && !identity.name && !account.name) return fail(res, 400, NAME_FIRST);

  if (Object.keys(identity).length) {
    try {
      account = await updateAccountIdentity(String(account._id), identity);
    } catch (err) {
      if (err instanceof EmailTakenError) {
        return fail(res, 409, "That email is already used by another account.");
      }
      throw err;
    }
  }

  // The first save with a name creates or links the record, so the wellness
  // fields sent alongside it land in the same request. Whether that record
  // belongs to another login is only known here, so a 409 comes after the
  // name and email above were saved.
  const customer = await linkCustomerForAccount(account);
  if (customer) await applyWellnessPatch(customer.customer_id, wellness, identity.email);
  else if (needsRecord) return noClinicRecord(res, account, NAME_FIRST);

  return res
    .status(200)
    .json({ success: true, message: "Profile updated.", data: await profileOf(account) });
};

// Runs before express.raw in the route, so a refused upload is never buffered.
export const limitPhotoUploads = (req: Request, res: Response, next: NextFunction) => {
  if (tooManyRequests(`cphoto:${signedIn(req)._id}`, 5, HOUR_MS)) {
    return fail(res, 429, "Too many photo uploads. Please try again later.");
  }
  next();
};

// req.body is the raw image (express.raw in the route); any other
// Content-Type leaves it unparsed.
export const uploadMyPhoto = async (req: Request, res: Response) => {
  if (!Buffer.isBuffer(req.body)) {
    return fail(res, 415, "Send the photo as image/jpeg, image/png or image/webp.");
  }
  if (req.body.length === 0) return fail(res, 400, "The photo is empty.");
  const image = sniffImage(req.body);
  if (!image || !req.is(image.type)) return fail(res, 400, "That file isn't a valid image.");

  // Before linking, which can create the clinic record: a 503 must not follow a write.
  if (!isUploadConfigured()) return fail(res, 503, "Photo upload isn't available right now.");

  const account = signedIn(req);
  const customer = await linkCustomerForAccount(account);
  if (!customer) return noClinicRecord(res, account, "Add your name before uploading a photo.");

  let url: string;
  try {
    url = await uploadBuffer({
      buffer: req.body,
      filename: `customer-${customer.customer_id}-${Date.now()}.${image.ext}`,
      type: image.type,
    });
  } catch (err) {
    logger.error("Profile photo upload failed", {
      customerId: customer.customer_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail(res, 502, "Couldn't save the photo right now. Please try again.");
  }
  await setProfilePhoto(customer.customer_id, url);
  // Only once the new URL is saved, so a failed save never loses the old photo.
  if (customer.profilePhotoUrl) await deleteUploadedFile(customer.profilePhotoUrl);
  return res
    .status(200)
    .json({ success: true, message: "Photo updated.", data: await profileOf(account) });
};

export const listMyBookings = async (req: Request, res: Response) => {
  const bookings = await listBookingsForPhone(fromE164(signedIn(req).phoneE164));
  return res.status(200).json({ success: true, data: bookings });
};

export const createMyBooking = async (req: Request, res: Response) => {
  const result = validateBookingRequest(req.body);
  if (!result.ok) return fail(res, 400, result.message);
  const account = signedIn(req);
  if (tooManyRequests(`cbook:${account._id}`, 10, HOUR_MS)) {
    return fail(res, 429, "Too many bookings. Please try again later.");
  }

  // The clinic record's name first: bookings are matched to customers by
  // phone + name, so this keeps the booking on the same customer.
  const customer = await linkCustomerForAccount(account);
  const name = customer?.name ?? account.name;
  if (!name) return fail(res, 400, "Add your name to your profile first.");

  const booked = await createBookingForCustomer(
    {
      phone10: fromE164(account.phoneE164),
      name,
      email: account.email || customer?.email,
      defaultLocation:
        [customer?.address, customer?.city, customer?.pincode].filter(Boolean).join(", ") ||
        undefined,
    },
    result.value,
  );
  if (!booked.ok) return fail(res, booked.status, booked.message);

  return res.status(booked.folded ? 200 : 201).json({
    success: true,
    message: booked.folded
      ? "We already have your enquiry - we've noted your latest details."
      : "Booking received - our team will reach out shortly.",
    data: { enquiryId: booked.enquiryId, folded: booked.folded },
  });
};
