import type { IncomingMessage } from "node:http";

type RateLimitState = { count: number; resetAt: number };
const buckets = new Map<string, RateLimitState>();

export function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

export function hitRateLimit(namespace: string, key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const bucketKey = `${namespace}:${key}`;
  const current = buckets.get(bucketKey);
  if (!current || current.resetAt <= now) {
    buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return false;
  }
  if (current.count >= max) {
    return true;
  }
  current.count += 1;
  return false;
}
