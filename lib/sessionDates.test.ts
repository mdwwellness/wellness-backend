import { describe, it, expect } from "vitest";
import { addonLabel, clockLabel, courseLabel, dayLabel, paidAtLabel, visitLabel } from "./sessionDates.ts";

const visit = { slot: { date: new Date("2026-10-16T00:00:00Z"), time: "16:30" } };

describe("session dates on the invoice", () => {
  it("writes days and times one way", () => {
    expect(dayLabel("2026-10-16")).toBe("16 Oct 2026");
    expect(clockLabel("15:30")).toBe("3:30 PM");
    expect(clockLabel("9:30")).toBe("9:30 AM");
    expect(visitLabel(visit)).toBe("16 Oct 2026, 4:30 PM");
    expect(visitLabel({})).toBeUndefined();
  });

  it("a course reads as its date range", () => {
    expect(courseLabel(["2026-10-30", new Date("2026-10-16T00:00:00Z"), "2026-11-06", "2026-10-23"])).toBe(
      "16 Oct 2026 to 6 Nov 2026, 4 sessions",
    );
  });

  it("an add-on reads as the same visit, its own visit, or a series", () => {
    expect(addonLabel({ slot: { date: "2026-10-16", time: "16:30" }, firstInVisit: true }, visit)).toBe("16 Oct 2026, same visit");
    expect(addonLabel({}, visit)).toBe("16 Oct 2026, same visit"); // older, unscheduled
    expect(addonLabel({ slot: { date: "2026-10-17", time: "15:30" } }, visit)).toBe("17 Oct 2026, 3:30 PM");
    expect(addonLabel({ slot: { date: "2026-10-17", time: "15:30" }, sessions: 4, intervalDays: 7 }, visit)).toBe(
      "17 Oct 2026, 3:30 PM + 3 more, every 7 days",
    );
  });

  it("a payment's time is in India", () => {
    expect(paidAtLabel("2026-10-16T07:19:00Z")).toBe("16 Oct 2026, 12:49 PM");
  });
});
