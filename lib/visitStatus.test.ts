import { describe, it, expect, vi, beforeEach } from "vitest";

// Every visit stored for the bookings, whoever's they are.
const m = vi.hoisted(() => ({ stored: [] as any[], projection: "" }));
vi.mock("../models/appointmentsBookingModel.ts", () => ({
  default: {
    find: (filter: any, projection: string) => {
      m.projection = projection;
      const ids: string[] = filter.$or[0].packageOriginId.$in;
      return { lean: async () => m.stored.filter((v) => ids.includes(v.packageOriginId) || ids.includes(v.addonOf?.bookingId)) };
    },
  },
}));

import { visitStatusOf, withVisitStatus } from "./visitStatus.ts";

const visit = (over: object) => ({ _id: "v1", status: "scheduled", doctorId: "THR-1", doctor: "Dr. A", ...over });

beforeEach(() => {
  m.stored = [];
});

describe("visitStatusOf (client list B2 #9)", () => {
  it("follows the code: OTP Pending, Visit Pending, Session Live, Completed", () => {
    expect(visitStatusOf(visit({}), [])).toBe("otp_pending");
    expect(visitStatusOf(visit({ visitOtpSentAt: new Date() }), [])).toBe("visit_pending");
    expect(visitStatusOf(visit({ visitOtpSentAt: new Date(), visitOtpVerified: true, status: "ongoing" }), [])).toBe("session_live");
    expect(visitStatusOf(visit({ status: "completed" }), [])).toBe("completed");
  });

  it("leaves no therapist yet, or a cancelled booking, to its stored status", () => {
    expect(visitStatusOf(visit({ doctorId: undefined, doctor: undefined }), [])).toBeNull();
    expect(visitStatusOf(visit({ status: "cancelled" }), [])).toBeNull();
  });

  it("a package goes by its next session not yet done, and is Completed only when all are", () => {
    const origin = visit({ _id: "c", status: "completed" });
    const s2 = visit({ _id: "s2", packageOriginId: "c", visitOtpSentAt: new Date(), slot: { date: new Date("2026-11-01"), time: "10:00" } });
    const s3 = visit({ _id: "s3", packageOriginId: "c", slot: { date: new Date("2026-11-08"), time: "10:00" } });
    expect(visitStatusOf(origin, [s3, s2])).toBe("visit_pending");
    expect(visitStatusOf(origin, [{ ...s2, status: "completed" }, s3])).toBe("otp_pending");
    expect(visitStatusOf(origin, [{ ...s2, status: "completed" }, { ...s3, status: "completed" }])).toBe("completed");
  });
});

describe("withVisitStatus: the same status for every viewer", () => {
  it("a therapist's booking takes its status from a session that's someone else's", async () => {
    const mine = visit({ _id: "c", status: "completed" });
    // Session 2 is another therapist's, and its code was entered.
    m.stored = [visit({ _id: "s2", packageOriginId: "c", doctorId: "THR-2", visitOtpSentAt: new Date(), visitOtpVerified: true, status: "ongoing" })];

    const [row] = await withVisitStatus([mine]);

    expect(row.visitStatus).toBe("session_live");
    // Only what the rule needs is read from the other therapist's visit.
    expect(m.projection.split(" ")).not.toContain("name");
  });

  it("a visit listed on its own goes by itself", async () => {
    const [row] = await withVisitStatus([visit({ _id: "s3", packageOriginId: "c", visitOtpSentAt: new Date() })]);
    expect(row.visitStatus).toBe("visit_pending");
  });
});
