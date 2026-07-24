import express from "express";
import {
  getClinicSettings,
  updateClinicSettings,
} from "../controllers/clinicSettingsController.ts";
import userAuth from "../middlewares/userAuth.ts";

const clinicSettingsRouter = express.Router();
clinicSettingsRouter.get("/", userAuth, getClinicSettings);
clinicSettingsRouter.put("/", userAuth, updateClinicSettings);
export default clinicSettingsRouter;
