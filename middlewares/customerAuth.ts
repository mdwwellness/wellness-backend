import type { NextFunction, Request, Response } from "express";
import { verifyCustomerToken } from "../lib/customerToken.ts";
import { findAccountById } from "../lib/customerAccount.ts";
import type { Account } from "../lib/customerAccount.ts";

declare global {
  namespace Express {
    interface Request {
      customerAccount?: Account;
    }
  }
}

const INVALID = { success: false, message: "Invalid or expired session." };

/**
 * Customers' App auth. The token comes ONLY from the Authorization header:
 * staff sessions live in the accessToken cookie, and accepting cookies here
 * would let a browser silently send one on a cross-site request.
 * The account is re-read on every request so blocking it takes effect at once.
 */
const customerAuth = async (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) {
    return res.status(401).json({ success: false, message: "Sign in required." });
  }

  const result = verifyCustomerToken(token);
  if (!result.ok) {
    return res.status(401).json(result.expired ? { ...INVALID, code: "TOKEN_EXPIRED" } : INVALID);
  }

  // A DB error rejects here and Express 5 sends it to the error handler (500),
  // not a 401 that would make the app sign the customer out.
  const account = await findAccountById(result.accountId);
  if (!account) return res.status(401).json(INVALID);
  if (account.status === "blocked") {
    return res.status(403).json({ success: false, message: "This account is blocked." });
  }
  if (!account.products?.includes("wellness")) {
    return res
      .status(403)
      .json({ success: false, message: "This account isn't registered for MDW Wellness." });
  }

  req.customerAccount = account;
  next();
};

export default customerAuth;
