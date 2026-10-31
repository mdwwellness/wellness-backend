import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  create: vi.fn(),
  move: vi.fn(),
  del: vi.fn(),
  configured: true,
}));

// Just enough of the model: findById().lean() and updateOne with $set / $unset.
vi.mock("../models/appointmentsBookingModel.ts", () => ({
  default: {
    findById: (id: string) => ({ lean: async () => structuredClone(m.rows.get(id) ?? null) }),
    updateOne: async ({ _id }: any, u: any) => {
      const row = m.rows.get(_id);
      if (!row) return { matchedCount: 0 };
      for (const [k, v] of Object.entries(u.$set ?? {})) {
        const [a, b] = k.split(".");
        if (b) row[a][b] = v;
        else row[a] = v;
      }
      for (const k of Object.keys(u.$unset ?? {})) delete row[k];
      return { matchedCount: 1 };
    },
  },
}));
vi.mock("./googleMeet.ts", () => ({
  googleMeetConfigured: () => m.configured,
  createMeetEvent: m.create,
  moveMeetEvent: m.move,
  deleteMeetEvent: m.del,
}));
vi.mock("./invoiceGeneration.ts", () => ({ BOOKING_TYPE_SERVICE: {} }));
vi.mock("./logger.ts", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { dropBookingMeet, syncBookingMeet, visitWindow } from "./bookingMeet.ts";

const consult = (over: any = {}) => ({
  _id: "b1",
  enquiryId: "ENQ-0101",
  typeOfappointment: "consultation",
  bookingKind: "intake",
  status: "ongoing",
  slot: { date: new Date("2026-11-05T00:00:00.000Z"), time: "10:30" },
  therapyStartTime: "10:30",
  therapyEndTime: "11:15",
  ...over,
});
const put = (row: any) => (m.rows.set(row._id, row), row);
const sync = (row: any) => syncBookingMeet(put(row));

beforeEach(() => {
  m.rows.clear();
  m.configured = true;
  m.create.mockReset().mockResolvedValue({ eventId: "ev1", meetLink: "https://meet.google.com/abc-defg-hij" });
  m.move.mockReset().mockResolvedValue(undefined);
  m.del.mockReset().mockResolvedValue(undefined);
});

describe("visitWindow", () => {
  it("reads the slot as India time and uses the end time", () => {
    expect(visitWindow(consult())).toEqual({
      start: new Date("2026-11-05T05:00:00.000Z"),
      end: new Date("2026-11-05T05:45:00.000Z"),
    });
  });

  it("falls back to 30 minutes when the end is missing or not after the start", () => {
    const w = visitWindow(consult({ therapyEndTime: "" }))!;
    expect(w.end.getTime() - w.start.getTime()).toBe(30 * 60_000);
    const back = visitWindow(consult({ therapyEndTime: "09:00" }))!;
    expect(back.end.getTime() - back.start.getTime()).toBe(30 * 60_000);
  });

  it("takes the start time first, then physioSlot, then slot (as the clash check does)", () => {
    const w = visitWindow(consult({ therapyStartTime: "", physioSlot: { time: "9:05" }, therapyEndTime: "" }))!;
    expect(w.start).toEqual(new Date("2026-11-05T03:35:00.000Z"));
  });

  it("gives null for a missing day or an unreadable time", () => {
    expect(visitWindow(consult({ slot: { time: "10:30" } }))).toBeNull();
    expect(visitWindow(consult({ therapyStartTime: "10.30 AM" }))).toBeNull();
    expect(visitWindow(consult({ therapyStartTime: "25:00" }))).toBeNull();
  });
});

describe("syncBookingMeet", () => {
  it("makes the call once a consultation has a confirmed slot", async () => {
    await sync(consult());
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(m.create.mock.calls[0][0].summary).toBe("MDW Wellness online consultation (ENQ-0101)");
    expect(m.rows.get("b1").meet).toEqual({
      link: "https://meet.google.com/abc-defg-hij",
      eventId: "ev1",
      start: "2026-11-05T05:00:00.000Z",
      end: "2026-11-05T05:45:00.000Z",
    });
  });

  it("does nothing for an unconfirmed enquiry, a home visit or a course", async () => {
    await sync(consult({ status: "enquiry" }));
    await sync(consult({ _id: "b2", typeOfappointment: "appointment" }));
    await sync(consult({ _id: "b3", bookingKind: "course" }));
    expect(m.create).not.toHaveBeenCalled();
  });

  it("does nothing when Google isn't set up", async () => {
    m.configured = false;
    await sync(consult());
    expect(m.create).not.toHaveBeenCalled();
  });

  it("leaves the call alone when nothing about the time changed", async () => {
    await sync(consult());
    await sync(m.rows.get("b1"));
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(m.move).not.toHaveBeenCalled();
  });

  it("moves the same event when the slot moves, keeping the link", async () => {
    await sync(consult());
    await sync({ ...m.rows.get("b1"), therapyStartTime: "12:00", therapyEndTime: "12:30" });
    expect(m.move).toHaveBeenCalledWith("ev1", new Date("2026-11-05T06:30:00.000Z"), new Date("2026-11-05T07:00:00.000Z"));
    expect(m.rows.get("b1").meet).toMatchObject({ link: "https://meet.google.com/abc-defg-hij", start: "2026-11-05T06:30:00.000Z" });
  });

  it("removes the call when the booking is cancelled or stops being a consultation", async () => {
    await sync(consult());
    await sync({ ...m.rows.get("b1"), status: "cancelled" });
    expect(m.del).toHaveBeenCalledWith("ev1");
    expect(m.rows.get("b1").meet).toBeUndefined();

    await sync(consult({ _id: "b2" }));
    await sync({ ...m.rows.get("b2"), typeOfappointment: "appointment" });
    expect(m.del).toHaveBeenCalledTimes(2);
    expect(m.rows.get("b2").meet).toBeUndefined();
  });

  it("keeps a finished call's link and never makes one for a done visit", async () => {
    await sync(consult());
    await sync({ ...m.rows.get("b1"), status: "completed", therapyStartTime: "15:00" });
    expect(m.move).not.toHaveBeenCalled();
    expect(m.rows.get("b1").meet.link).toBe("https://meet.google.com/abc-defg-hij");
    await sync(consult({ _id: "b2", status: "completed" }));
    expect(m.create).toHaveBeenCalledTimes(1);
  });

  it("keeps the link when the time can't be read", async () => {
    await sync(consult());
    await sync({ ...m.rows.get("b1"), therapyStartTime: "noon" });
    expect(m.del).not.toHaveBeenCalled();
    expect(m.move).not.toHaveBeenCalled();
  });

  it("two quick saves make one event", async () => {
    let release!: () => void;
    m.create.mockImplementation(
      () => new Promise((r) => (release = () => r({ eventId: "ev1", meetLink: "https://meet.google.com/x" }))),
    );
    const first = sync(consult());
    const second = syncBookingMeet(m.rows.get("b1"));
    await vi.waitFor(() => expect(m.create).toHaveBeenCalled());
    release();
    await Promise.all([first, second]);
    expect(m.create).toHaveBeenCalledTimes(1);
  });

  it("never throws when Google fails, and the next save tries again", async () => {
    m.create.mockRejectedValueOnce(new Error("Google Calendar 503"));
    await expect(sync(consult())).resolves.toBeUndefined();
    expect(m.rows.get("b1").meet).toBeUndefined();
    await sync(m.rows.get("b1"));
    expect(m.rows.get("b1").meet.eventId).toBe("ev1");
  });

  it("keeps the link if removing the event fails, so a later save retries", async () => {
    await sync(consult());
    m.del.mockRejectedValueOnce(new Error("Google Calendar 503"));
    await sync({ ...m.rows.get("b1"), status: "cancelled" });
    expect(m.rows.get("b1").meet.eventId).toBe("ev1");
    await sync(m.rows.get("b1"));
    expect(m.rows.get("b1").meet).toBeUndefined();
  });

  it("removes an event made for a booking deleted meanwhile", async () => {
    m.create.mockImplementation(async () => {
      m.rows.delete("b1");
      return { eventId: "ev9", meetLink: "https://meet.google.com/y" };
    });
    await sync(consult());
    expect(m.del).toHaveBeenCalledWith("ev9");
  });
});

describe("dropBookingMeet", () => {
  it("deletes the event of a deleted booking, and swallows a Google failure", async () => {
    await dropBookingMeet({ _id: "b1", meet: { eventId: "ev1" } });
    expect(m.del).toHaveBeenCalledWith("ev1");
    m.del.mockRejectedValueOnce(new Error("down"));
    await expect(dropBookingMeet({ _id: "b1", meet: { eventId: "ev1" } })).resolves.toBeUndefined();
    await dropBookingMeet({ _id: "b2" });
    expect(m.del).toHaveBeenCalledTimes(2);
  });
});
