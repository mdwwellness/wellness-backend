import express from "express";
import {
    getSessionRates,
    updateSessionRates,
} from "../controllers/sessionRateController.ts";
import userAuth from "../middlewares/userAuth.ts";
import checkPermission from "../middlewares/checkPermissions.ts";
import { PERMISSIONS } from "../lib/index.ts";

const sessionRateRouter = express.Router();

// Read stays open (pricing is quoted from several screens); only editing the
// tier table is back-office work.
sessionRateRouter.get("/", userAuth, getSessionRates);
sessionRateRouter.put(
  "/",
  userAuth,
  checkPermission(PERMISSIONS.SERVICE_MANAGE),
  updateSessionRates,
);

export default sessionRateRouter;
