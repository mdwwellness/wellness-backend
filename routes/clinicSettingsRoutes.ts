import express from "express";
import {
  getClinicSettings,
  updateClinicSettings,
} from "../controllers/clinicSettingsController.ts";
import userAuth from "../middlewares/userAuth.ts";
import checkPermission from "../middlewares/checkPermissions.ts";
import { PERMISSIONS } from "../lib/index.ts";

const clinicSettingsRouter = express.Router();

// GET must stay open to therapists: the earnings page and the therapist
// earnings tab read therapistSplitPercent to work out their own cut.
clinicSettingsRouter.get("/", userAuth, getClinicSettings);
clinicSettingsRouter.put(
  "/",
  userAuth,
  checkPermission(PERMISSIONS.SETTINGS_MANAGE),
  updateClinicSettings,
);
export default clinicSettingsRouter;
