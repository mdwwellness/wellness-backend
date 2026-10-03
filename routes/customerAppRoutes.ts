import express from "express";
import customerAuth from "../middlewares/customerAuth.ts";
import {
  createMyBooking,
  getMyProfile,
  limitPhotoUploads,
  listMyBookings,
  sendLoginOtp,
  updateMyProfile,
  uploadMyPhoto,
  verifyLoginOtp,
} from "../controllers/customerAppController.ts";
import { customerJwtSecret } from "../lib/env.ts";
import { isOtpConfigured } from "../lib/msg91.ts";
import { IMAGE_TYPES } from "../lib/imageType.ts";
import { logger } from "../lib/logger.ts";

// Customers' App, separate from the staff /api/customers routes and their cookies.
const customerAppRouter = express.Router();

// Without its own signing secret no customer token can be issued or checked, so
// the whole app answers 503 while the staff dashboard keeps running.
customerAppRouter.use((req, res, next) => {
  if (customerJwtSecret()) return next();
  res.status(503).json({ success: false, message: "Customer accounts aren't available right now." });
});

customerAppRouter.post("/auth/otp", sendLoginOtp);
customerAppRouter.post("/auth/verify", verifyLoginOtp);
customerAppRouter.get("/me", customerAuth, getMyProfile);
customerAppRouter.patch("/me", customerAuth, updateMyProfile);
// Auth and the upload limit before the body parser, so neither an anonymous
// nor a refused caller can make us buffer 4 MB.
customerAppRouter.put(
  "/me/photo",
  customerAuth,
  limitPhotoUploads,
  express.raw({ type: IMAGE_TYPES, limit: "4mb" }),
  uploadMyPhoto,
);
customerAppRouter.get("/bookings", customerAuth, listMyBookings);
customerAppRouter.post("/bookings", customerAuth, createMyBooking);

// Called by server.ts once .env is loaded, so a half-configured app shows in
// the boot log instead of only as 503s.
export function warnIfCustomerAppUnconfigured(): void {
  if (!customerJwtSecret()) {
    logger.warn(
      "CUSTOMER_JWT_SECRET is unset, shorter than 32 characters or equal to JWT_SECRET: /api/customer-app answers 503.",
    );
  }
  if (!isOtpConfigured()) {
    logger.warn("MSG91 is not configured: customer phone sign-in answers 503.");
  }
}

export default customerAppRouter;
