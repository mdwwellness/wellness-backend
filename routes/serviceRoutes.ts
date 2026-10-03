import express from "express";
import {
    addService,
    deleteService,
    getServices,
    updateService,
} from "../controllers/serviceController.ts";
import userAuth from "../middlewares/userAuth.ts";
import checkPermission from "../middlewares/checkPermissions.ts";
import { PERMISSIONS } from "../lib/index.ts";

const serviceRouter = express.Router();

const canManage = checkPermission(PERMISSIONS.SERVICE_MANAGE);

// GET stays open to any authenticated user on purpose: therapists read the
// catalogue mid-visit when recommending an add-on (visit-tab.tsx).
serviceRouter.post("/", userAuth, canManage, addService);
serviceRouter.get("/", userAuth, getServices);
serviceRouter.put("/:serviceId", userAuth, canManage, updateService);
serviceRouter.delete("/:serviceId", userAuth, canManage, deleteService);

export default serviceRouter;
