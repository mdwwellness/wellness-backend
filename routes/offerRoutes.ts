import express from "express";
import {
  addOffer,
  deleteOffer,
  getOffer,
  getOffers,
  updateOffer,
} from "../controllers/offerController.ts";
import { applyOffer, removeOffer } from "../controllers/bookingOfferController.ts";
import userAuth from "../middlewares/userAuth.ts";
import requireRole from "../middlewares/requireRole.ts";

const offerRouter = express.Router();

// Reading offers is open to any authenticated dashboard user (the booking form
// needs the list to build its "Apply offer" dropdown). Creating / editing /
// deleting an offer is Super-Admin only — the four back-office roles share all
// permissions, so only requireRole can single out Super Admin.
offerRouter.get("/", userAuth, getOffers);
offerRouter.get("/:offerId", userAuth, getOffer);
offerRouter.post("/", userAuth, requireRole("SUPER_ADMIN"), addOffer);
offerRouter.put("/:offerId", userAuth, requireRole("SUPER_ADMIN"), updateOffer);
offerRouter.delete("/:offerId", userAuth, requireRole("SUPER_ADMIN"), deleteOffer);

// Applying / removing an offer on a booking line is an office action (a
// therapist can never do it; the per-offer minRole is checked in the handler).
const OFFICE = ["SUPER_ADMIN", "ADMIN", "STAFF", "CUSTOMER_CARE"];
offerRouter.post("/booking/:bookingId/apply", userAuth, requireRole(...OFFICE), applyOffer);
offerRouter.post("/booking/:bookingId/remove", userAuth, requireRole(...OFFICE), removeOffer);

export default offerRouter;
