import express from "express";
import {
  addDoctor,
  deleteDoctor,
  getDoctors,
  getDoctorByUserId,
  getPersonalAppointments,
  updateDoctorDetails,
  deleteTherapistSuperAdmin,
  updateTherapistSuperAdmin,
} from "../controllers/DoctorController.ts";
import userAuth from "../middlewares/userAuth.ts";
import superAdminAuth from "../middlewares/superAdminAuth.ts";
const doctorRouter = express.Router();

doctorRouter.post("/", userAuth, addDoctor);
doctorRouter.get("/", userAuth, getDoctors);
doctorRouter.get("/by-user/:userId", userAuth, getDoctorByUserId);

// Super-admin routes MUST come before /:id routes to avoid Express matching /:id first
doctorRouter.put(
  "/super-update/:id",
  userAuth,
  superAdminAuth,
  updateTherapistSuperAdmin
);
doctorRouter.delete(
  "/super-delete/:id",
  userAuth,
  superAdminAuth,
  deleteTherapistSuperAdmin
);

doctorRouter.get("/:id", userAuth, getPersonalAppointments);
doctorRouter.put("/:id", userAuth, updateDoctorDetails);
doctorRouter.delete("/:id", userAuth, deleteDoctor);

export default doctorRouter;
