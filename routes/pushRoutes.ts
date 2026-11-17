import express from "express";
import { getPushKey, removeSubscription, saveSubscription } from "../controllers/pushController.ts";
import userAuth from "../middlewares/userAuth.ts";

const pushRouter = express.Router();

pushRouter.get("/key", userAuth, getPushKey);
pushRouter.post("/subscriptions", userAuth, saveSubscription);
pushRouter.delete("/subscriptions", userAuth, removeSubscription);

export default pushRouter;
