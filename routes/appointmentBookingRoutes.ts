import express from "express";
import { addAppointmentsDetails, deleteAppointment, getAllAppointments, updateAppointment } from "../controllers/appointmentController.ts";

const appointmentRouter = express.Router();


appointmentRouter.post("/",addAppointmentsDetails)
appointmentRouter.get("/",getAllAppointments);
appointmentRouter.put("/:id",updateAppointment);
appointmentRouter.delete("/:id",deleteAppointment);

export default appointmentRouter