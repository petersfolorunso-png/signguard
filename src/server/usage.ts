/**
 * Public traction stats. Stores DIDs (pseudonymous T3N ids) and verdict counts
 * only — never the pasted tx, the user's rules, or IPs.
 */
import { JsonFile } from "./jsonfile.js";
import type { Verdict } from "../core/types.js";

interface UsageState {
  dids: Record<string, { first: number; last: number; checks: number }>;
  checks: { ts: number; did: string; verdict: Verdict; source: string; kinds: string[]; credits?: number }[];
  totals: { checks: number; allow: number; warn: number; block: number; credits: number };
}

export class Usage {
  private f: JsonFile<UsageState>;
  constructor(path: string) {
    this.f = new JsonFile<UsageState>(path, { dids: {}, checks: [], totals: { checks: 0, allow: 0, warn: 0, block: 0, credits: 0 } });
  }

  identity(did: string) {
    const now = Date.now();
    this.f.data.dids[did] ??= { first: now, last: now, checks: 0 };
    this.f.save();
  }

  record(did: string, verdict: Verdict, source: string, kinds: string[], credits?: number) {
    const now = Date.now();
    const d = (this.f.data.dids[did] ??= { first: now, last: now, checks: 0 });
    d.last = now;
    d.checks++;
    const t = this.f.data.totals;
    t.checks++;
    t[verdict]++;
    if (credits) t.credits = Math.round((t.credits + credits) * 1e6) / 1e6;
    this.f.data.checks.push({ ts: now, did, verdict, source, kinds, credits });
    if (this.f.data.checks.length > 10000) this.f.data.checks.splice(0, this.f.data.checks.length - 10000);
    this.f.save();
  }

  /** Public dashboard numbers. DIDs are truncated. */
  stats() {
    const { dids, checks, totals } = this.f.data;
    const all = Object.values(dids);
    const day = 86400_000;
    const now = Date.now();
    const series: { date: string; checks: number; users: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const start = new Date(new Date(now - i * day).toISOString().slice(0, 10)).getTime();
      const inDay = checks.filter((c) => c.ts >= start && c.ts < start + day);
      series.push({ date: new Date(start).toISOString().slice(0, 10), checks: inDay.length, users: new Set(inDay.map((c) => c.did)).size });
    }
    return {
      uniqueDids: all.length,
      activeDids: all.filter((d) => d.checks > 0).length,
      returningDids: all.filter((d) => d.checks > 1 && d.last - d.first > 3600_000).length,
      dids24h: all.filter((d) => d.last > now - day).length,
      totals,
      series,
      recent: checks.slice(-12).reverse().map((c) => ({ ts: c.ts, did: truncDid(c.did), verdict: c.verdict, kinds: c.kinds })),
    };
  }

  /** Full DID list for the DoraHacks submission ("list all DIDs involved"). */
  exportDids() {
    return Object.entries(this.f.data.dids).map(([did, d]) => ({ did, firstSeen: new Date(d.first).toISOString(), lastSeen: new Date(d.last).toISOString(), checks: d.checks }));
  }

  flush() {
    this.f.flush();
  }
}

export const truncDid = (did: string) => (did.length > 22 ? `${did.slice(0, 14)}…${did.slice(-4)}` : did);
