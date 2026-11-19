import type { Rules, TxFacts, PolicyResult } from "../core/types";
import type { Explanation } from "../core/explain";

export type LoginMethod = "anonymous" | "email";
export interface Session {
  signedIn: boolean;
  handle?: string;
  did?: string;
  created?: boolean;
  hasRules?: boolean;
  loginMethod: LoginMethod;
  mode: "mock" | "real";
  /** Set right after email sign-in. */
  sponsored?: number;
  notes?: string[];
}
export interface EmailStart { pendingId: string; expiresInSec: number; demoCode?: string }
export interface CheckResponse {
  did?: string;
  /** Signed-out visitors (email mode) get a local preview; sign in to run it in the enclave. */
  needsSignIn?: boolean;
  source: string;
  facts: TxFacts[];
  result: PolicyResult;
  policySource: "t3n-tee" | "mock-tee" | "preview";
  credits?: number;
  explanation: Explanation;
}
export interface Stats {
  mode: "mock" | "real";
  uniqueDids: number;
  activeDids: number;
  returningDids: number;
  dids24h: number;
  totals: { checks: number; allow: number; warn: number; block: number; credits: number };
  series: { date: string; checks: number; users: number }[];
  recent: { ts: number; did: string; verdict: "allow" | "warn" | "block"; kinds: string[] }[];
}

export class ApiError extends Error {
  constructor(msg: string, public status: number, public signIn = false, public retryAfterSecs?: number) { super(msg); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The host's "waking up / bad gateway" answers (free tier cold start). */
const transient = (status: number) => status === 502 || status === 503 || status === 504;

async function req<T>(path: string, init?: RequestInit, opts: { retries?: number; onWait?: () => void } = {}): Promise<T> {
  let r: Response | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      r = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
      if (!transient(r.status) || attempt >= (opts.retries ?? 0)) break;
    } catch {
      if (attempt >= (opts.retries ?? 0)) throw new ApiError("Can't reach SignGuard right now. Check your connection and try again.", 0);
    }
    opts.onWait?.();
    await sleep(Math.min(2000 * 2 ** attempt, 10000));
  }
  const res = r!;
  const j = (res.headers.get("content-type") ?? "").includes("json") ? await res.json().catch(() => ({})) : {};
  if (transient(res.status)) throw new ApiError("SignGuard is waking up. Give it a few seconds and try again.", res.status);
  if (!res.ok) {
    if (res.status === 401) localStorage.removeItem(HANDLE_KEY);
    throw new ApiError(j.error ?? `Request failed (${res.status})`, res.status, !!j.signIn, j.retryAfterSecs);
  }
  return j as T;
}

const HANDLE_KEY = "signguard.handle";
const RULES_KEY = "signguard.rules";

/** Retries for ~1 minute: a free-tier server may be cold-starting. */
export async function startSession(onWait?: () => void): Promise<Session> {
  const s = await req<Session>("/api/session", { method: "POST", body: JSON.stringify({ handle: localStorage.getItem(HANDLE_KEY) ?? undefined }) }, { retries: 7, onWait });
  if (s.handle) localStorage.setItem(HANDLE_KEY, s.handle);
  else localStorage.removeItem(HANDLE_KEY);
  return s;
}

/** Email sign-in step 1: Terminal 3 emails a code (mock mode returns it as demoCode instead). */
export const emailStart = (email: string) => req<EmailStart>("/api/auth/email/start", { method: "POST", body: JSON.stringify({ email }) });

/** Email sign-in step 2: verify the code -> your own registered did:t3n. */
export async function emailVerify(pendingId: string, code: string, name?: string): Promise<Session> {
  const s = await req<Session>("/api/auth/email/verify", { method: "POST", body: JSON.stringify({ pendingId, code, name: name || undefined }) });
  if (s.handle) localStorage.setItem(HANDLE_KEY, s.handle);
  return s;
}

export const signOut = () => { localStorage.removeItem(HANDLE_KEY); localStorage.removeItem(RULES_KEY); };

export const check = (handle: string | undefined, input: string, chainId?: number, to?: string) =>
  req<CheckResponse>("/api/check", { method: "POST", body: JSON.stringify({ handle, input, chainId, to }) });

export const saveRules = async (handle: string, rules: Rules) => {
  await req("/api/rules", { method: "PUT", body: JSON.stringify({ handle, rules }) });
  // Device-only copy so the editor can show your rules; the T3N vault is the source of truth.
  localStorage.setItem(RULES_KEY, JSON.stringify(rules));
};

export const localRules = (): Rules | null => {
  try { return JSON.parse(localStorage.getItem(RULES_KEY) ?? "null"); } catch { return null; }
};

export const getStats = () => req<Stats>("/api/stats");
export const getDefaults = () => req<Rules>("/api/defaults");
export const getStatus = () => req<{ mode: string; network: string; ready: boolean; contract?: string; agentDid?: string; notes: string[] }>("/api/status");
