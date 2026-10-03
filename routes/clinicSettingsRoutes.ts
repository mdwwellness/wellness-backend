import express from "express";
import {
  getClinicSettings,
  updateClinicSettings,
} from "../controllers/clinicSettingsController.ts";
import userAuth from "../middlewares/userAuth.ts";
import checkPermission from "../middlewares/checkPermissions.ts";
import { PERMISSIONS } from "../lib/index.ts";

const clinicSettingsRouter = express.Router();

// GET stays open to every signed-in role: the booking forms read the gap.
clinicSettingsRouter.get("/", userAuth, getClinicSettings);
clinicSettingsRouter.put(
  "/",
  userAuth,
  checkPermission(PERMISSIONS.SETTINGS_MANAGE),
  updateClinicSettings,
);
export default clinicSettingsRouter;
