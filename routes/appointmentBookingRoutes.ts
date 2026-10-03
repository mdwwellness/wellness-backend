import express from "express";
import {
  addAppointmentsDetails,
  addAppointmentRecommendation,
  confirmAppointmentRecommendation,
  sendAddonOtp,
  setAddonPaymentStatus,
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
} from "../controllers/appointmentController.ts";
import userAuth from "../middlewares/userAuth.ts";
import checkPermission from "../middlewares/checkPermissions.ts";
import { PERMISSIONS } from "../lib/index.ts";
const appointmentRouter = express.Router();

// Public, unauthenticated booking endpoint (patient site). Rate-limited.
// Declared before the authed "/" so there's no chance of middleware overlap.
appointmentRouter.post("/public", addPublicEnquiry);

// Public, unauthenticated payment summary for the customer's /pay/<token> page.
// Guarded by an unguessable token, field-limited, and rate-limited.
appointmentRouter.get("/pay/:token", getPublicPaymentSummary);

appointmentRouter.post("/", userAuth, addAppointmentsDetails);
appointmentRouter.get("/", userAuth, getAllAppointments);
appointmentRouter.get("/therapist-session-counts", userAuth, getTherapistSessionCounts);
appointmentRouter.post("/:id/pay-link", userAuth, createPaymentLink);
appointmentRouter.post("/:id/recommendations", userAuth, addAppointmentRecommendation);
appointmentRouter.post("/:id/recommendations/otp", userAuth, sendAddonOtp);
appointmentRouter.post("/:id/recommendations/confirm", userAuth, confirmAppointmentRecommendation);
appointmentRouter.post("/:id/recommendations/payment", userAuth, setAddonPaymentStatus);
appointmentRouter.post("/:id/visit-otp/send", userAuth, sendVisitOtp);
appointmentRouter.post("/:id/visit-otp/verify", userAuth, verifyVisitOtp);
appointmentRouter.post("/:id/complete-session", userAuth, completeSession);
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
