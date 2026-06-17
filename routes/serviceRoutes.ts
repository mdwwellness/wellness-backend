import express from "express";
import {
    addService,
    deleteService,
    getServices,
    updateService,
} from "../controllers/serviceController.ts";
import userAuth from "../middlewares/userAuth.ts";

const serviceRouter = express.Router();

serviceRouter.post("/", userAuth, addService);
serviceRouter.get("/", userAuth, getServices);
serviceRouter.put("/:serviceId", userAuth, updateService);
serviceRouter.delete("/:serviceId", userAuth, deleteService);

export default serviceRouter;
