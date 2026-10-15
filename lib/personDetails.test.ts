import { describe, it, expect } from "vitest";
import { birthYearFrom, customerAge, toAge, toGender } from "./personDetails.ts";

describe("personDetails", () => {
  it("keeps only the stored genders, whatever the case", () => {
    expect(toGender("Female")).toBe("female");
    expect(toGender(" male ")).toBe("male");
    expect(toGender("Prefer not to say")).toBeUndefined();
    expect(toGender(undefined)).toBeUndefined();
  });

  it("keeps only whole ages from 1 to 120", () => {
    expect(toAge("32")).toBe(32);
    expect(toAge(32)).toBe(32);
    for (const bad of [0, 121, 32.5, "", "abc", null, undefined]) expect(toAge(bad)).toBeUndefined();
  });

  it("turns an age into a birth year from when it was given", () => {
    expect(birthYearFrom("30", "2026-10-16T05:00:00Z")).toBe(1996);
    expect(birthYearFrom(30, "2024-03-01T05:00:00Z")).toBe(1994);
    expect(birthYearFrom(0, "2026-10-16T05:00:00Z")).toBeUndefined();
  });

  it("an exact date of birth wins over a birth year", () => {
    expect(customerAge({ birthYear: 1996 }, "2026-10-16")).toBe(30);
    expect(customerAge({ dob: new Date("1996-12-01"), birthYear: 1990 }, "2026-10-16")).toBe(29);
    expect(customerAge({}, "2026-10-16")).toBeUndefined();
  });
});
