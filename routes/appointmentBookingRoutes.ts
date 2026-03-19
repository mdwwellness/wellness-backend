import express from "express";
import {
  addAppointmentsDetails,
  deleteAppointment,
  getAllAppointments,
  updateAppointment,
} from "../controllers/appointmentController.ts";
import userAuth from "../middlewares/userAuth.ts";
const appointmentRouter = express.Router();

appointmentRouter.post("/", userAuth, addAppointmentsDetails);
appointmentRouter.get("/", userAuth, getAllAppointments);
appointmentRouter.put("/:id", userAuth, updateAppointment);
appointmentRouter.delete("/:id", userAuth, deleteAppointment);

export default appointmentRouter;
