import type { Request } from "express";

// In-memory fixed-window limiter for the public (NO auth) endpoints. Callers
// key buckets "<scope>:<ip or phone>" so endpoints never share a budget: a
// customer loading their payment page must not be able to lock a different
// person out of the booking form, or vice versa.
// ponytail: per-process memory, so limits reset on deploy and don't add up
// across instances; move to Redis/Mongo if the backend ever scales out.
const buckets = new Map<string, { count: number; resetAt: number }>();
// Keys can carry client-sent text (X-Forwarded-For), so their length and their
// number are both capped: 20k spoofed long values once held ~290 MB here.
const MAX_KEY_LENGTH = 100;
const MAX_BUCKETS = 50_000;
const PRUNE_EVERY_MS = 60_000;
let lastPrunedAt = 0;

function pruneExpired(now: number) {
  lastPrunedAt = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}

export function tooManyRequests(
  rawKey: string,
  limit: number,
  windowMs = 60_000,
): boolean {
  const key = rawKey.slice(0, MAX_KEY_LENGTH);
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    // Unique keys (one per IP / phone) would otherwise grow the map forever.
    // A full scan per insert is what made a key flood expensive, so at most
    // once a minute.
    if (now - lastPrunedAt >= PRUNE_EVERY_MS) pruneExpired(now);
    buckets.delete(key);
    // Full of live buckets: refuse the new key rather than evict a live one.
    // Evicting let a flood of fresh keys reset other limits, including the
    // global SMS cap and a victim's OTP-guess counters.
    // ponytail: during such a flood, callers with new keys get 429 until
    // windows expire; a shared store (Redis) lifts the cap.
    if (buckets.size >= MAX_BUCKETS) return true;
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  bucket.count++;
  return bucket.count > limit;
}

// With "trust proxy" set, Express derives req.ip from the hops it trusts, so a
// client can't pick its own bucket. Without it, the first X-Forwarded-For entry
// is whatever the client sent and can be spoofed to dodge per-IP limits.
// Per-phone limits don't depend on it.
export function clientIp(req: Request): string {
  // Express's default is false; 0 (no proxy in front) still makes req.ip right.
  const trust = req.app?.get("trust proxy");
  if (trust !== undefined && trust !== false) return req.ip || "unknown";
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}
