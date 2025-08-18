import express from "express";
import { addAppointmentsDetails, getAllAppointments } from "../controllers/appointmentController.ts";

const appointmentRouter = express.Router();


appointmentRouter.post("/",addAppointmentsDetails)
appointmentRouter.get("/",getAllAppointments);

export default appointmentRouter