import { describe, expect, it } from "vitest";
import { parseProfileLink } from "./profileLink.ts";

describe("parseProfileLink", () => {
  it("keeps an http(s) link, trimmed", () => {
    expect(parseProfileLink("  https://www.linkedin.com/in/asha ")).toBe("https://www.linkedin.com/in/asha");
    expect(parseProfileLink("http://practo.com/x")).toBe("http://practo.com/x");
  });

  it("empty or missing clears it", () => {
    expect(parseProfileLink("")).toBe("");
    expect(parseProfileLink("   ")).toBe("");
    expect(parseProfileLink(undefined)).toBe("");
    expect(parseProfileLink(null)).toBe("");
  });

  it("refuses anything that isn't an http(s) URL", () => {
    expect(parseProfileLink("javascript:alert(1)")).toBeNull();
    expect(parseProfileLink("data:text/html,hi")).toBeNull();
    expect(parseProfileLink("linkedin.com/in/asha")).toBeNull();
    expect(parseProfileLink(42)).toBeNull();
    expect(parseProfileLink(`https://x.com/${"a".repeat(600)}`)).toBeNull();
  });
});
