import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  send: vi.fn(),
  userFind: vi.fn(),
  doctorFindOne: vi.fn(),
  subFind: vi.fn(),
  subDelete: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("web-push", () => ({ default: { sendNotification: m.send } }));
vi.mock("../models/userModel.ts", () => ({ default: { find: m.userFind } }));
vi.mock("../models/doctorsModel.ts", () => ({ Doctor: { findOne: m.doctorFindOne } }));
vi.mock("../models/pushSubscriptionModel.ts", () => ({
  PushSubscription: { find: m.subFind, deleteOne: m.subDelete },
}));
vi.mock("./logger.ts", () => ({ logger: { info: vi.fn(), warn: m.warn, error: vi.fn() } }));

import { isPushEndpoint, notifyAssigned, notifyNewBooking, officeAlert, therapistAlert, visitWhen } from "./push.ts";

const lean = (v: unknown) => ({ lean: () => Promise.resolve(v) });
const OFFICE = ["6650000000000000000000a1", "6650000000000000000000a2", "6650000000000000000000a3"];
const THERAPIST_USER = "6650000000000000000000b1";
// Every user's one phone.
const device = (userId: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${userId}`, keys: { p256dh: "p", auth: "a" }, userId });

/** Who each send went to, and what it said. */
const sends = () => m.send.mock.calls.map(([sub, payload]) => ({ to: sub.endpoint.split("/").pop(), ...JSON.parse(payload) }));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VAPID_PUBLIC_KEY = "test-public";
  process.env.VAPID_PRIVATE_KEY = "test-private";
  m.send.mockResolvedValue({ statusCode: 201 });
  m.userFind.mockImplementation((filter: any) =>
    lean(filter.role === "THERAPIST" ? [{ _id: THERAPIST_USER }] : OFFICE.map((_id) => ({ _id }))),
  );
  m.doctorFindOne.mockReturnValue(lean({ doctorId: "THR-0004", userId: THERAPIST_USER, email: "t@x.com" }));
  m.subFind.mockImplementation((filter: any) => lean(filter.userId.$in.map(device)));
});

const enquiry = { _id: "e1", enquiryId: "ENQ-0200", name: "Asha", service: "Physiotherapy", status: "enquiry" };
const booking = {
  _id: "b1", enquiryId: "ENQ-0201", name: "Ravi", service: "Massage", status: "scheduled",
  doctorId: "THR-0004", slot: { date: "2026-11-14", time: "11:30" },
};

describe("who gets a phone alert", () => {
  it("a new enquiry rings every office phone except the person who made it, and no therapist", async () => {
    await notifyNewBooking(enquiry, { actorId: OFFICE[0] });
    expect(sends()).toEqual([
      { to: OFFICE[1], title: "New enquiry", body: "Asha · Physiotherapy", url: "/dashboard/enquiries", tag: "booking-e1" },
      { to: OFFICE[2], title: "New enquiry", body: "Asha · Physiotherapy", url: "/dashboard/enquiries", tag: "booking-e1" },
    ]);
    // Only active office logins are asked for.
    expect(m.userFind.mock.calls[0][0]).toEqual({ role: { $in: ["SUPER_ADMIN", "ADMIN", "STAFF", "CUSTOMER_CARE"] }, isActive: true });
    expect(m.doctorFindOne).not.toHaveBeenCalled();
  });

  it("a new booking that already has a therapist rings the office and that therapist; a course is one alert", async () => {
    await notifyNewBooking(booking, { visits: 5 });
    const s = sends();
    expect(s.filter((x) => x.title === "New booking")).toHaveLength(3);
    expect(s.find((x) => x.to === THERAPIST_USER)).toMatchObject({
      title: "New booking assigned to you",
      url: "/dashboard/appointments",
    });
    expect(s.every((x) => x.body.endsWith("(+5 visits)"))).toBe(true);
  });

  it("an assignment rings only that therapist's phones, found the way their login is linked", async () => {
    await notifyAssigned(booking, { actorId: OFFICE[0] });
    expect(sends().map((x) => x.to)).toEqual([THERAPIST_USER]);
    expect(m.userFind).toHaveBeenCalledWith(
      { $or: [{ _id: THERAPIST_USER }, { userEmail: "t@x.com" }], role: "THERAPIST", isActive: true },
      { _id: 1 },
    );
  });

  it("a therapist who assigns themselves, or a booking with no therapist, rings nobody", async () => {
    await notifyAssigned(booking, { actorId: THERAPIST_USER });
    await notifyAssigned({ ...booking, doctorId: "" });
    expect(m.send).not.toHaveBeenCalled();
  });

  it("off until the VAPID keys are set", async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    await notifyNewBooking(booking);
    expect(m.send).not.toHaveBeenCalled();
  });
});

describe("delivery never breaks a booking", () => {
  it("a phone the push service says is gone is forgotten; other failures are logged, not thrown", async () => {
    m.send.mockImplementation((sub: any) =>
      sub.endpoint.endsWith(OFFICE[1])
        ? Promise.reject(Object.assign(new Error("gone"), { statusCode: 410 }))
        : sub.endpoint.endsWith(OFFICE[2])
          ? Promise.reject(Object.assign(new Error("server error"), { statusCode: 500 }))
          : Promise.resolve({ statusCode: 201 }),
    );
    await expect(notifyNewBooking(enquiry)).resolves.toBeUndefined();
    expect(m.subDelete).toHaveBeenCalledWith({ endpoint: `https://fcm.googleapis.com/fcm/send/${OFFICE[1]}` });
    expect(m.subDelete).toHaveBeenCalledTimes(1);
    expect(m.warn).toHaveBeenCalledWith("Push alert failed", { status: 500, message: "server error" });
  });

  it("a database error is logged, not thrown", async () => {
    m.userFind.mockImplementation(() => ({ lean: () => Promise.reject(new Error("db down")) }));
    await expect(notifyNewBooking(booking)).resolves.toBeUndefined();
    expect(m.warn).toHaveBeenCalled();
  });
});

describe("the alert text", () => {
  it("names the customer and service, or the visit's day and time in India", () => {
    expect(officeAlert({ ...booking, status: "scheduled" }).title).toBe("New booking");
    expect(officeAlert({ _id: "x", name: "", service: "" })).toMatchObject({ title: "New enquiry", body: "Customer · Booking" });
    expect(therapistAlert(booking).body).toMatch(/^Ravi · Sat,? 14 Nov, 11:30$/);
    expect(visitWhen({ slot: { date: new Date("2026-11-14T00:00:00.000Z") }, therapyStartTime: "09:00" })).toMatch(/14 Nov, 09:00$/);
    expect(visitWhen({})).toBe("time not set yet");
  });
});

describe("isPushEndpoint: only real push services, so a client can't aim the server anywhere", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://wns2-pn1p.notify.windows.com/w/?token=abc",
    "https://web.push.apple.com/abc",
  ])("accepts %s", (url) => expect(isPushEndpoint(url)).toBe(true));

  it.each([
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com.evil.com/x",
    "https://evilfcm.googleapis.com.attacker.net/x",
    "https://localhost/x",
    "https://169.254.169.254/latest",
    "not a url",
    42,
    `https://fcm.googleapis.com/${"a".repeat(1000)}`,
  ])("rejects %s", (url) => expect(isPushEndpoint(url)).toBe(false));
});
