import mongoose from "mongoose";

/**
 * One browser that turned on booking alerts (lib/push.ts). Only the device and
 * whose it is: who gets an alert is decided from the user's live role when it's
 * sent, so a role change or a deactivated account takes effect at once.
 */
const pushSubscriptionSchema = new mongoose.Schema(
  {
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userId: { type: String, required: true, index: true },
  },
  { timestamps: true, versionKey: false },
);

export const PushSubscription = mongoose.model("PushSubscription", pushSubscriptionSchema);
