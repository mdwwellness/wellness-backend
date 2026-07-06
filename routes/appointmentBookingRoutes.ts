import express from "express";
import {
  addAppointmentsDetails,
  addAppointmentRecommendation,
  confirmAppointmentRecommendation,
  setAddonPaymentStatus,
  completeSession,
  addPublicEnquiry,
  deleteAppointment,
  getAllAppointments,
  updateAppointment,
} from "../controllers/appointmentController.ts";
import userAuth from "../middlewares/userAuth.ts";
const appointmentRouter = express.Router();

// Public, unauthenticated booking endpoint (patient site). Rate-limited.
// Declared before the authed "/" so there's no chance of middleware overlap.
appointmentRouter.post("/public", addPublicEnquiry);

appointmentRouter.post("/", userAuth, addAppointmentsDetails);
appointmentRouter.get("/", userAuth, getAllAppointments);
appointmentRouter.post("/:id/recommendations", userAuth, addAppointmentRecommendation);
appointmentRouter.post("/:id/recommendations/confirm", userAuth, confirmAppointmentRecommendation);
appointmentRouter.post("/:id/recommendations/payment", userAuth, setAddonPaymentStatus);
appointmentRouter.post("/:id/complete-session", userAuth, completeSession);
appointmentRouter.put("/:id", userAuth, updateAppointment);
appointmentRouter.delete("/:id", userAuth, deleteAppointment);

export default appointmentRouter;
