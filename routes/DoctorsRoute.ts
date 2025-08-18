import express  from "express";
import { addDoctor, getDoctors, getPersonalAppointments } from "../controllers/DoctorController.ts";

const doctorRouter = express.Router();

doctorRouter.post("/",addDoctor)
doctorRouter.get("/",getDoctors)
doctorRouter.get("/:id",getPersonalAppointments)

export default doctorRouter