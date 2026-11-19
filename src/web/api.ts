import type { Rules, TxFacts, PolicyResult } from "../core/types";
import type { Explanation } from "../core/explain";

export interface Session { handle: string; did: string; created: boolean; hasRules: boolean; mode: "mock" | "real" }
export interface CheckResponse {
  did: string;
  source: string;
  facts: TxFacts[];
  result: PolicyResult;
  policySource: "t3n-tee" | "mock-tee";
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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j as T;
}

const HANDLE_KEY = "signguard.handle";
const RULES_KEY = "signguard.rules";

export async function startSession(): Promise<Session> {
  const s = await req<Session>("/api/session", { method: "POST", body: JSON.stringify({ handle: localStorage.getItem(HANDLE_KEY) ?? undefined }) });
  localStorage.setItem(HANDLE_KEY, s.handle);
  return s;
}

export const check = (handle: string, input: string, chainId?: number, to?: string) =>
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
