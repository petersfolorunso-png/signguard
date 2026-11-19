/** Shared helpers for email-code sign-in (mock + real). */
import { UserFacingError } from "./adapter.js";

/** Same lifetime T3N gives a pending email login (ten minutes). */
export const PENDING_TTL_SECS = 600;

export function normalizeEmail(raw: unknown): string {
  const email = String(raw ?? "").trim().toLowerCase();
  // Deliberately simple: T3N does the real validation by delivering the code.
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new UserFacingError("That doesn't look like an email address.");
  }
  return email;
}

export function normalizeCode(raw: unknown): string {
  const code = String(raw ?? "").replace(/[\s-]/g, "");
  if (!/^[A-Za-z0-9]{4,12}$/.test(code)) throw new UserFacingError("Enter the code from the email.");
  return code;
}

/** Tiny in-memory sliding-window limiter (per key). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  /** Returns seconds to wait, or 0 if allowed (and records the hit). */
  take(key: string, now = Date.now()): number {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return Math.max(1, Math.ceil((arr[0] + this.windowMs - now) / 1000));
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 10000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    return 0;
  }
}
