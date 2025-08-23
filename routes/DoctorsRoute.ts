import express  from "express";
import { addDoctor, deleteDoctor, getDoctors, getPersonalAppointments, updateDoctorDetails } from "../controllers/DoctorController.ts";

const doctorRouter = express.Router();

doctorRouter.post("/",addDoctor)
doctorRouter.get("/",getDoctors)
doctorRouter.get("/:id",getPersonalAppointments)
doctorRouter.put("/:id",updateDoctorDetails)
doctorRouter.delete("/:id",deleteDoctor)

export default doctorRouter