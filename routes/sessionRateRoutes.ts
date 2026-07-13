import express from "express";
import {
    getSessionRates,
    updateSessionRates,
} from "../controllers/sessionRateController.ts";
import userAuth from "../middlewares/userAuth.ts";

const sessionRateRouter = express.Router();

sessionRateRouter.get("/", userAuth, getSessionRates);
sessionRateRouter.put("/", userAuth, updateSessionRates);

export default sessionRateRouter;
