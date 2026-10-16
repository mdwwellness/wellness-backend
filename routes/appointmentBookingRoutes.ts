import express from "express";
import {
  addAppointmentsDetails,
  addAppointmentRecommendation,
  confirmAppointmentRecommendation,
  sendAddonOtp,
  completeSession,
  sendVisitOtp,
  verifyVisitOtp,
  addPublicEnquiry,
  createPaymentLink,
  getPublicPaymentSummary,
  deleteAppointment,
  getAllAppointments,
  updateAppointment,
  getTherapistSessionCounts,
  addPayment,
} from "../controllers/appointmentController.ts";
import userAuth from "../middlewares/userAuth.ts";
import requireRole from "../middlewares/requireRole.ts";
import checkPermission from "../middlewares/checkPermissions.ts";
import { PERMISSIONS } from "../lib/index.ts";
const appointmentRouter = express.Router();

// Public, unauthenticated booking endpoint (patient site). Rate-limited.
// Declared before the authed "/" so there's no chance of middleware overlap.
appointmentRouter.post("/public", addPublicEnquiry);

// Public, unauthenticated payment summary for the customer's /pay/<token> page.
// Guarded by an unguessable token, field-limited, and rate-limited.
appointmentRouter.get("/pay/:token", getPublicPaymentSummary);

// New bookings are the office's job; therapists only work on visits assigned to them.
appointmentRouter.post("/", userAuth, requireRole("SUPER_ADMIN", "ADMIN", "STAFF", "CUSTOMER_CARE"), addAppointmentsDetails);
appointmentRouter.get("/", userAuth, getAllAppointments);
appointmentRouter.get("/therapist-session-counts", userAuth, getTherapistSessionCounts);
appointmentRouter.post("/:id/pay-link", userAuth, createPaymentLink);
// Money received (part or full); a therapist only on their own visit (checked in the handler).
appointmentRouter.post("/:id/payments", userAuth, requireRole("SUPER_ADMIN", "ADMIN", "STAFF", "THERAPIST"), addPayment);
appointmentRouter.post("/:id/recommendations", userAuth, addAppointmentRecommendation);
appointmentRouter.post("/:id/recommendations/otp", userAuth, sendAddonOtp);
appointmentRouter.post("/:id/recommendations/confirm", userAuth, confirmAppointmentRecommendation);
// Session start: the office sends the code to the customer, and only the
// assigned therapist can enter it - so a therapist can never start a session
// without the customer reading the code back.
appointmentRouter.post("/:id/visit-otp/send", userAuth, requireRole("SUPER_ADMIN", "ADMIN", "STAFF"), sendVisitOtp);
appointmentRouter.post("/:id/visit-otp/verify", userAuth, requireRole("THERAPIST"), verifyVisitOtp);
// The therapist completes the visit; an admin can step in for them (logged).
appointmentRouter.post("/:id/complete-session", userAuth, requireRole("THERAPIST", "SUPER_ADMIN", "ADMIN"), completeSession);
appointmentRouter.put("/:id", userAuth, updateAppointment);
// Deleting a booking is only reachable from the Enquiries drawer, which
// therapists can't open. Everything above stays open to them on purpose:
// completing sessions, visit OTPs and add-on recommendations are their job.
appointmentRouter.delete(
  "/:id",
  userAuth,
  checkPermission(PERMISSIONS.APPOINTMENT_DELETE),
  deleteAppointment,
);

export default appointmentRouter;
