import express from "express";
import {
  addAppointmentsDetails,
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
appointmentRouter.put("/:id", userAuth, updateAppointment);
appointmentRouter.delete("/:id", userAuth, deleteAppointment);

export default appointmentRouter;
