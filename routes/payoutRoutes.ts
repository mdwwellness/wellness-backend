import express from "express";
import { addSettlement, getPayoutBalances } from "../controllers/payoutController.ts";
import userAuth from "../middlewares/userAuth.ts";
import requireRole from "../middlewares/requireRole.ts";

const payoutRouter = express.Router();

payoutRouter.get("/", userAuth, getPayoutBalances);
payoutRouter.post("/settlements", userAuth, requireRole("SUPER_ADMIN", "ADMIN"), addSettlement);

export default payoutRouter;
