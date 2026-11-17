import type { Request, Response } from "express";
import { PushSubscription } from "../models/pushSubscriptionModel.ts";
import { isPushEndpoint, pushPublicKey } from "../lib/push.ts";

/** The key a browser subscribes with. Empty: phone alerts aren't set up on this server. */
export const getPushKey = (_req: Request, res: Response) =>
  res.status(200).send({ success: true, message: "OK", data: pushPublicKey() });

const isKey = (k: unknown) => typeof k === "string" && k.length > 0 && k.length <= 200;

/**
 * This browser wants phone alerts for the logged-in user. Saving it again
 * (every visit) is fine; a device that changes hands moves to its new user.
 */
export const saveSubscription = async (req: Request, res: Response) => {
  try {
    const { endpoint, keys } = req.body ?? {};
    if (!isPushEndpoint(endpoint) || !isKey(keys?.p256dh) || !isKey(keys?.auth)) {
      return res.status(400).send({ success: false, message: "Invalid push subscription." });
    }
    await PushSubscription.updateOne(
      { endpoint },
      { $set: { keys: { p256dh: keys.p256dh, auth: keys.auth }, userId: String(req.user?._id ?? "") } },
      { upsert: true },
    );
    return res.status(200).send({ success: true, message: "Alerts on for this device" });
  } catch (error: any) {
    return res.status(500).send({ success: false, message: error.message });
  }
};

/** Logging out: this browser stops getting this user's alerts. */
export const removeSubscription = async (req: Request, res: Response) => {
  try {
    const { endpoint } = req.body ?? {};
    if (typeof endpoint !== "string") {
      return res.status(400).send({ success: false, message: "Invalid push subscription." });
    }
    await PushSubscription.deleteOne({ endpoint, userId: String(req.user?._id ?? "") });
    return res.status(200).send({ success: true, message: "Alerts off for this device" });
  } catch (error: any) {
    return res.status(500).send({ success: false, message: error.message });
  }
};
