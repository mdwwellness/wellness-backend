import jwt from "jsonwebtoken";
import { customerJwtSecret } from "./env.ts";

/** Same lifetime as a patient-site session. */
export const CUSTOMER_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/** `ttlSeconds` is only shortened for hand-issued test tokens (scripts/issue-test-token.ts). */
export function signCustomerToken(accountId: string, ttlSeconds = CUSTOMER_TOKEN_TTL_SECONDS): string {
  const secret = customerJwtSecret();
  if (!secret) throw new Error("CUSTOMER_JWT_SECRET is not configured.");
  return jwt.sign({ sub: accountId, typ: "customer" }, secret, {
    algorithm: "HS256",
    expiresIn: ttlSeconds,
  });
}

export function verifyCustomerToken(
  token: string,
): { ok: true; accountId: string } | { ok: false; expired: boolean } {
  const secret = customerJwtSecret();
  if (!secret) return { ok: false, expired: false };
  try {
    // Pinned algorithm: never let the token header pick "none" or another HMAC.
    const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
    // typ keeps any other token type that might ever share this secret out.
    if (typeof payload === "string" || payload.typ !== "customer") return { ok: false, expired: false };
    // A malformed id needs no check here: findAccountById finds no account for
    // it, so customerAuth answers 401 all the same.
    if (typeof payload.sub !== "string" || !payload.sub) return { ok: false, expired: false };
    return { ok: true, accountId: payload.sub };
  } catch (err) {
    // jsonwebtoken checks the signature before expiry, so "expired" is only
    // reported for tokens we really issued.
    return { ok: false, expired: err instanceof jwt.TokenExpiredError };
  }
}
