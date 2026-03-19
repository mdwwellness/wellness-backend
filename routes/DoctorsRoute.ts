import express from "express";
import {
  addDoctor,
  deleteDoctor,
  getDoctors,
  getPersonalAppointments,
  updateDoctorDetails,
} from "../controllers/DoctorController.ts";
import userAuth from "../middlewares/userAuth.ts";
const doctorRouter = express.Router();

doctorRouter.post("/", userAuth, addDoctor);
doctorRouter.get("/", userAuth, getDoctors);
doctorRouter.get("/:id", userAuth, getPersonalAppointments);
doctorRouter.put("/:id", userAuth, updateDoctorDetails);
doctorRouter.delete("/:id", userAuth, deleteDoctor);

export default doctorRouter;
