import { inspect } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { logger } from "./logger.ts";
import { maskPhone } from "./phone.ts";

// 4xx errors raised by middleware (bad JSON 400, body too large 413, CORS 403)
// are the client's fault, so they keep their status instead of becoming a 500.
export function clientErrorStatus(err: any): number | null {
  const status = err?.status ?? err?.statusCode;
  return Number.isInteger(status) && status >= 400 && status < 500 ? status : null;
}

/**
 * Error text can quote personal data: a Mongo E11000 names the duplicate
 * phoneE164, a cast error the value it rejected. Every run of 10+ digits
 * keeps only its last 4, like maskPhone.
 */
export function redactDigits(text: string): string {
  return text.replace(/\d{10,}/g, (digits) => maskPhone(digits));
}

/** The app's last error handler (Express 5 forwards async route errors here too). */
export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  const status = clientErrorStatus(err);
  if (status) {
    // No err.message here: a JSON parse error quotes the body (OTP, phone).
    logger.warn(`${req.method} ${req.originalUrl} → ${status}`);
    if (res.headersSent) return;
    res.status(status).send({
      success: false,
      message: err.expose ? err.message : "Request rejected",
    });
    return;
  }
  const detail = err instanceof Error ? err.stack || err.message : inspect(err);
  logger.error(`Unhandled error on ${req.method} ${req.originalUrl}`, redactDigits(detail));
  if (res.headersSent) return;
  res.status(500).send({ success: false, message: "Server error" });
}
