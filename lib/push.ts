import mongoose from "mongoose";
import webpush from "web-push";
import User from "../models/userModel.ts";
import { Doctor } from "../models/doctorsModel.ts";
import { PushSubscription } from "../models/pushSubscriptionModel.ts";
import { logger } from "./logger.ts";
import { OFFICE_ROLES } from "./index.ts";

/**
 * Phone alerts (web push), owner's rules 2026-11-12, the same as the dashboard's
 * in-page alert (InboundBookingNotifier):
 * - the office (Super Admin, Admin, Staff, Customer Care) hears about every new
 *   enquiry and booking;
 * - a therapist hears about bookings assigned to them;
 * - nobody hears about something they did themselves.
 * Off until VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set. Never throws: a
 * missed alert must never fail the booking it's about.
 */


// The push services browsers use. Only these are accepted, so a client can't
// make the server send requests to any URL it likes.
const PUSH_HOSTS = ["fcm.googleapis.com", "push.services.mozilla.com", "notify.windows.com", "push.apple.com"];

export function isPushEndpoint(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 1000) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export const pushPublicKey = () => process.env.VAPID_PUBLIC_KEY ?? "";

export type Alert = { title: string; body: string; url: string; tag: string };

/** "Sat 14 Nov, 11:30" in India time, from the visit's slot. */
export function visitWhen(b: any): string {
  const d = b?.slot?.date ? new Date(b.slot.date) : null;
  const day = d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" })
    : "";
  const time = b?.therapyStartTime || b?.slot?.time || "";
  return [day, time].filter(Boolean).join(", ") || "time not set yet";
}

const more = (visits: number) => (visits > 0 ? ` (+${visits} visits)` : "");

/** The office's alert: a new enquiry, or a new booking. */
export function officeAlert(b: any, visits = 0): Alert {
  const enquiry = !b.status || b.status === "enquiry";
  return {
    title: enquiry ? "New enquiry" : "New booking",
    body: `${b.name || "Customer"} · ${b.service || b.typeOfappointment || "Booking"}${more(visits)}`,
    url: enquiry ? "/dashboard/enquiries" : "/dashboard/appointments",
    tag: `booking-${b._id}`,
  };
}

/** A therapist's alert: a booking is now theirs. */
export function therapistAlert(b: any, visits = 0): Alert {
  return {
    title: "New booking assigned to you",
    body: `${b.name || "Customer"} · ${visitWhen(b)}${more(visits)}`,
    url: "/dashboard/appointments",
    tag: `assigned-${b._id}`,
  };
}

const ids = (users: any[]) => users.map((u) => String(u._id));

async function officeUserIds(): Promise<string[]> {
  return ids(await User.find({ role: { $in: OFFICE_ROLES }, isActive: true }, { _id: 1 }).lean());
}

/** The login(s) of a therapist, matched the way ownDoctorId matches them (lib/payments.ts). */
async function therapistUserIds(doctorId: string): Promise<string[]> {
  const doctor: any = await Doctor.findOne({ doctorId }, { userId: 1, email: 1 }).lean();
  if (!doctor) return [];
  const who: Record<string, unknown>[] = [];
  if (doctor.userId && mongoose.isValidObjectId(doctor.userId)) who.push({ _id: doctor.userId });
  if (doctor.email) who.push({ userEmail: doctor.email });
  if (!who.length) return [];
  return ids(await User.find({ $or: who, role: "THERAPIST", isActive: true }, { _id: 1 }).lean());
}

/** Send to every device of these users, dropping devices the push service says are gone. */
async function deliver(userIds: string[], alert: Alert): Promise<void> {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey || !userIds.length) return;
  const vapidDetails = {
    subject: process.env.VAPID_SUBJECT || "https://dashboard.wellness.mydawaiwala.com",
    publicKey,
    privateKey,
  };
  const subs: any[] = await PushSubscription.find({ userId: { $in: userIds } }).lean();
  await Promise.all(
    subs.map(async (s) => {
      try {
        // High urgency: Android delivers it at once, even with the screen off.
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(alert), {
          vapidDetails,
          TTL: 24 * 60 * 60,
          urgency: "high",
        });
      } catch (e: any) {
        // 404 / 410: the browser unsubscribed or its data was cleared.
        if (e?.statusCode === 404 || e?.statusCode === 410) await PushSubscription.deleteOne({ endpoint: s.endpoint });
        else logger.warn("Push alert failed", { status: e?.statusCode, message: e?.message });
      }
    }),
  );
}

const except = (list: string[], actorId?: string) => list.filter((id) => id !== actorId);

/**
 * A new enquiry or booking (createBooking): the office hears about it, and its
 * therapist too when it already has one. `visits`: a course's other sessions.
 */
export async function notifyNewBooking(b: any, opts: { visits?: number; actorId?: string } = {}): Promise<void> {
  try {
    await Promise.all([
      deliver(except(await officeUserIds(), opts.actorId), officeAlert(b, opts.visits)),
      b.doctorId ? notifyAssigned(b, opts) : null,
    ]);
  } catch (e: any) {
    logger.warn("Push alerts for a new booking failed", { enquiryId: b?.enquiryId, message: e?.message });
  }
}

/** A booking (or new visits of one) is now this therapist's. */
export async function notifyAssigned(b: any, opts: { visits?: number; actorId?: string } = {}): Promise<void> {
  try {
    if (!b?.doctorId) return;
    await deliver(except(await therapistUserIds(b.doctorId), opts.actorId), therapistAlert(b, opts.visits));
  } catch (e: any) {
    logger.warn("Push alert to a therapist failed", { enquiryId: b?.enquiryId, message: e?.message });
  }
}
