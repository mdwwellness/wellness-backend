import { timingSafeEqual } from "node:crypto";
import { logger } from "./logger.ts";
import { maskPhone } from "./phone.ts";

/**
 * MSG91 phone OTP for customer-app login. Same provider calls as the patient
 * site (mdw, src/app/api/auth/otp), so one OTP flow serves both products.
 *
 * MSG91 answers HTTP 200 with {"type":"error"} for rejected requests, so the
 * only success signal is type === "success"; a missing type is not success.
 *
 * Env: MSG91_AUTH_TOKEN + MSG91_TEMPLATE_ID (without the DLT template id MSG91
 * accepts the send but never delivers it). MSG91_DEMO_PHONE + MSG91_DEMO_OTP
 * enable a fixed OTP for that one phone, for tests only; never set them on Render.
 */

const BASE_URL = "https://api.msg91.com/api/v5";
const TIMEOUT_MS = 10_000;

/** Real MSG91 config is missing for a non-demo phone (route answers 503). */
export class OtpNotConfiguredError extends Error {}
/** MSG91 failed: network, timeout, non-2xx or an unexpected reply (route answers 502). */
export class OtpProviderError extends Error {}

function realConfig() {
  const authKey = process.env.MSG91_AUTH_TOKEN;
  const templateId = process.env.MSG91_TEMPLATE_ID;
  return authKey && templateId ? { authKey, templateId } : null;
}

// Both vars, a 10-digit phone and a 6+ digit OTP, or demo mode is off: a
// half-set or guessable demo OTP must never open a login.
function demoConfig() {
  const phone = process.env.MSG91_DEMO_PHONE ?? "";
  const otp = process.env.MSG91_DEMO_OTP ?? "";
  return /^\d{10}$/.test(phone) && /^\d{6,}$/.test(otp) ? { phone, otp } : null;
}

export function isOtpConfigured(): boolean {
  return Boolean(realConfig() || demoConfig());
}

function requireRealConfig() {
  const config = realConfig();
  if (!config) throw new OtpNotConfiguredError("MSG91_AUTH_TOKEN and MSG91_TEMPLATE_ID are not set.");
  return config;
}

// MSG91 messages can echo the mobile number, so long digit runs are masked.
const safeMessage = (message: unknown) =>
  typeof message === "string" ? message.replace(/\d{5,}/g, "***").slice(0, 200) : undefined;

type Reply = { status: number; ok: boolean; type?: unknown; message?: unknown };

function providerError(action: string, phone10: string, details: Partial<Reply> & { error?: string }) {
  logger.error(`MSG91 ${action} OTP failed`, {
    phone: maskPhone(phone10),
    status: details.status,
    type: details.type,
    message: safeMessage(details.message),
    error: details.error,
  });
  return new OtpProviderError(`MSG91 ${action} OTP failed.`);
}

async function callMsg91(action: string, path: string, authKey: string, payload: object, phone10: string): Promise<Reply> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authkey: authKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw providerError(action, phone10, { error: err instanceof Error ? err.name : "fetch failed" });
  }
  // Unparseable body leaves type undefined, which every caller treats as failure.
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, type: data?.type, message: data?.message };
}

export async function sendOtp(phone10: string): Promise<void> {
  if (demoConfig()?.phone === phone10) return;
  const { authKey, templateId } = requireRealConfig();
  // Pinned so the app's 6-box OTP input and "expires in 10 minutes" copy hold
  // whatever the MSG91 dashboard defaults are.
  const payload = { template_id: templateId, mobile: `91${phone10}`, otp_length: 6, otp_expiry: 10 };
  const reply = await callMsg91("send", "/otp", authKey, payload, phone10);
  if (!reply.ok || reply.type !== "success") throw providerError("send", phone10, reply);
}

/** true only on type "success"; false when MSG91 rejects the OTP (wrong or expired). */
export async function verifyOtp(phone10: string, otp: string): Promise<boolean> {
  const demo = demoConfig();
  if (demo?.phone === phone10) return sameSecret(otp, demo.otp);

  const { authKey } = requireRealConfig();
  const reply = await callMsg91("verify", "/otp/verify", authKey, { mobile: `91${phone10}`, otp }, phone10);
  if (reply.ok && reply.type === "success") return true;
  if (reply.ok && reply.type === "error") {
    logger.info("MSG91 rejected OTP", { phone: maskPhone(phone10), message: safeMessage(reply.message) });
    return false;
  }
  throw providerError("verify", phone10, reply);
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
