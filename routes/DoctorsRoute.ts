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
  getReferrals,
} from "../controllers/DoctorController.ts";
import userAuth from "../middlewares/userAuth.ts";
import superAdminAuth from "../middlewares/superAdminAuth.ts";
import checkPermission from "../middlewares/checkPermissions.ts";
import { PERMISSIONS } from "../lib/index.ts";
const doctorRouter = express.Router();

doctorRouter.post(
  "/",
  userAuth,
  checkPermission(PERMISSIONS.THERAPIST_CREATE),
  addDoctor,
);
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

doctorRouter.get("/:id/referrals", userAuth, getReferrals);
doctorRouter.get("/:id", userAuth, getPersonalAppointments);
// PUT stays open to THERAPIST_EDIT (which therapists hold) because the
// therapist detail page has no role gate, so a therapist editing their own
// "My Profile" record goes through here. It is NOT ownership-scoped, see #19.
doctorRouter.put("/:id", userAuth, updateDoctorDetails);
doctorRouter.delete(
  "/:id",
  userAuth,
  checkPermission(PERMISSIONS.THERAPIST_DELETE),
  deleteDoctor,
);

export default doctorRouter;
