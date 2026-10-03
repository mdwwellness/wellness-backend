import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request } from "express";
import { clientIp, tooManyRequests } from "./rateLimit.ts";

// The bucket map is module state shared by every test, so each test uses its
// own key prefix.
describe("tooManyRequests", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("allows `limit` calls per window, then blocks", () => {
    for (let i = 0; i < 5; i++) expect(tooManyRequests("a:1", 5)).toBe(false);
    expect(tooManyRequests("a:1", 5)).toBe(true);
  });

  it("keeps separate budgets per key", () => {
    expect(tooManyRequests("b:1", 1)).toBe(false);
    expect(tooManyRequests("b:1", 1)).toBe(true);
    expect(tooManyRequests("b:2", 1)).toBe(false);
  });

  it("resets after the default 60s window", () => {
    expect(tooManyRequests("c:1", 1)).toBe(false);
    expect(tooManyRequests("c:1", 1)).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(tooManyRequests("c:1", 1)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tooManyRequests("c:1", 1)).toBe(false);
  });

  it("honours a custom window", () => {
    const hour = 60 * 60_000;
    expect(tooManyRequests("d:1", 1, hour)).toBe(false);
    vi.advanceTimersByTime(30 * 60_000);
    expect(tooManyRequests("d:1", 1, hour)).toBe(true);
    vi.advanceTimersByTime(30 * 60_000 + 1);
    expect(tooManyRequests("d:1", 1, hour)).toBe(false);
  });

  it("caps the key length, so a huge spoofed header can't make a huge key", () => {
    const prefix = "e:" + "x".repeat(98);
    expect(tooManyRequests(prefix + "a".repeat(10_000), 1)).toBe(false);
    // Same first 100 characters: same bucket.
    expect(tooManyRequests(prefix + "b", 1)).toBe(true);
  });
});

// Pruning and eviction depend on the whole map, so these get a fresh module.
describe("tooManyRequests: memory bounds", () => {
  const HOUR = 60 * 60_000;
  let limiter: typeof tooManyRequests;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    ({ tooManyRequests: limiter } = await import("./rateLimit.ts"));
  });
  afterEach(() => vi.useRealTimers());

  // Keys Map.prototype.delete was called with while fn ran.
  function deletedDuring(fn: () => void): unknown[] {
    const del = vi.spyOn(Map.prototype, "delete");
    fn();
    const keys = del.mock.calls.map(([key]) => key);
    del.mockRestore();
    return keys;
  }

  it("prunes expired buckets at most once a minute, keeping live ones", () => {
    for (let i = 0; i < 10; i++) limiter(`old:${i}`, 1, 1_000);
    limiter("live:1", 1, HOUR);
    vi.advanceTimersByTime(2_000);

    // Expired, but the last prune (on the first insert) was under a minute ago.
    expect(deletedDuring(() => limiter("new:1", 1))).not.toContain("old:0");

    vi.advanceTimersByTime(60_000);
    const deleted = deletedDuring(() => limiter("new:2", 1));
    expect(deleted).toContain("old:0");
    expect(deleted).toContain("old:9");
    expect(deleted).not.toContain("live:1");
    expect(limiter("live:1", 1, HOUR)).toBe(true);
  });

  it("refuses new keys once 50,000 live ones are held, never evicting a live one", () => {
    for (let i = 0; i < 50_000; i++) limiter(`k:${i}`, 1, HOUR);

    // A flood of fresh keys must not reset anyone else's limit.
    expect(deletedDuring(() => expect(limiter("k:new", 1, HOUR)).toBe(true))).not.toContain("k:0");
    expect(limiter("k:0", 1, HOUR)).toBe(true);
    expect(limiter("k:49999", 1, HOUR)).toBe(true);
  });

  it("takes new keys again once the full map's windows have expired", () => {
    for (let i = 0; i < 50_000; i++) limiter(`k:${i}`, 1, 1_000);
    expect(limiter("k:new", 1, HOUR)).toBe(true);

    vi.advanceTimersByTime(61_000); // past the windows and the prune throttle
    expect(limiter("k:new", 1, HOUR)).toBe(false);
  });
});

describe("clientIp", () => {
  const req = (headers: Record<string, string>, remoteAddress?: string, extra: object = {}) =>
    ({ headers, socket: { remoteAddress }, ...extra }) as unknown as Request;
  const app = (trustProxy: unknown) => ({ get: (name: string) => (name === "trust proxy" ? trustProxy : undefined) });

  it("takes the first X-Forwarded-For entry", () => {
    expect(clientIp(req({ "x-forwarded-for": " 1.2.3.4 , 10.0.0.1" }))).toBe("1.2.3.4");
  });

  it("falls back to the socket address, then 'unknown'", () => {
    expect(clientIp(req({}, "5.6.7.8"))).toBe("5.6.7.8");
    expect(clientIp(req({}))).toBe("unknown");
  });

  it("uses req.ip when the app trusts a proxy, ignoring a spoofed header", () => {
    const behindProxy = req({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }, "10.0.0.1", {
      app: app(1),
      ip: "1.2.3.4",
    });
    expect(clientIp(behindProxy)).toBe("1.2.3.4");
    expect(clientIp(req({}, undefined, { app: app(true), ip: undefined }))).toBe("unknown");
  });

  it("uses req.ip when trust proxy is 0 (no proxy in front)", () => {
    const noProxy = req({ "x-forwarded-for": "6.6.6.6" }, "10.0.0.1", { app: app(0), ip: "10.0.0.1" });
    expect(clientIp(noProxy)).toBe("10.0.0.1");
  });

  it("keeps the X-Forwarded-For behaviour when trust proxy is off", () => {
    const direct = req({ "x-forwarded-for": "1.2.3.4" }, "10.0.0.1", { app: app(false), ip: "10.0.0.1" });
    expect(clientIp(direct)).toBe("1.2.3.4");
  });
});
