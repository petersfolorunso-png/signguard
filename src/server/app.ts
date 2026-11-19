import express, { type Request, type Response, type NextFunction } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { decode } from "../core/decoder.js";
import { DEFAULT_RULES, normalizeRules, toPolicyFacts } from "../core/rules.js";
import { explain } from "../core/explain.js";
import { SAMPLES } from "../core/samples.js";
import type { T3nAdapter } from "./t3n/adapter.js";
import type { Usage } from "./usage.js";
import { lookupTx, getPrices } from "./chain.js";

export interface AppDeps {
  adapter: T3nAdapter;
  usage: Usage;
  adminToken?: string;
  prices?: boolean;
  /** Injected in tests to avoid network. */
  lookup?: typeof lookupTx;
  rateLimitPerMin?: number;
}

const HANDLE_RE = /^[a-f0-9]{32}$/;

function limiter(perMin: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "?";
    const now = Date.now();
    const arr = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (arr.length >= perMin) return res.status(429).json({ error: "Slow down — too many checks. Try again in a minute." });
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 50_000) hits.clear();
    next();
  };
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
  fn(req, res).catch((e: Error) => res.status(/unknown user|save your rules|must be|allowlist|not an address/.test(e.message) ? 400 : 500).json({ error: e.message }));

export function createApp(deps: AppDeps) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "64kb" }));
  const lookup = deps.lookup ?? lookupTx;
  const rl = limiter(deps.rateLimitPerMin ?? 30);

  const handleOf = (req: Request) => {
    const h = String(req.body?.handle ?? req.header("x-sg-handle") ?? "");
    if (!HANDLE_RE.test(h)) throw new Error("unknown user — start a session first");
    return h;
  };

  app.get("/api/status", wrap(async (_req, res) => res.json(await deps.adapter.status())));
  app.get("/api/samples", (_req, res) => res.json(SAMPLES));
  app.get("/api/defaults", (_req, res) => res.json(DEFAULT_RULES));

  /** Start (or resume) a session: returns the browser handle + the user's did:t3n. */
  app.post("/api/session", rl, wrap(async (req, res) => {
    let handle = String(req.body?.handle ?? "");
    if (!HANDLE_RE.test(handle)) handle = randomBytes(16).toString("hex");
    const id = await deps.adapter.ensureIdentity(handle);
    deps.usage.identity(id.did);
    res.json({ handle, did: id.did, created: id.created, hasRules: await deps.adapter.hasRules(handle), mode: deps.adapter.mode });
  }));

  /** Save private rules to the user's T3N vault. Our server does not keep them. */
  app.put("/api/rules", rl, wrap(async (req, res) => {
    const handle = handleOf(req);
    const rules = normalizeRules(req.body?.rules);
    await deps.adapter.saveRules(handle, rules);
    res.json({ ok: true });
  }));

  app.post("/api/check", rl, wrap(async (req, res) => {
    const handle = handleOf(req);
    const input = String(req.body?.input ?? "");
    if (input.length > 60_000) return res.status(400).json({ error: "Input too large." });
    const chainId = req.body?.chainId ? Number(req.body.chainId) : undefined;
    const to = req.body?.to ? String(req.body.to) : undefined;
    const prices = await getPrices(deps.prices ?? false);
    let decoded = decode(input, { chainId, to, prices });
    if (decoded.source === "empty") return res.status(400).json({ error: "Paste a transaction, signature request, or tx hash." });
    if (decoded.source === "hash") {
      const tx = await lookup(decoded.hash!, chainId);
      if (!tx) return res.status(404).json({ error: "Couldn't find that tx hash on Ethereum, Base, Arbitrum, Optimism, Polygon or BNB Chain." });
      decoded = { ...decode(JSON.stringify(tx), { prices }), source: "hash", hash: decoded.hash };
    }
    if (!(await deps.adapter.hasRules(handle))) await deps.adapter.saveRules(handle, DEFAULT_RULES);
    const { did } = await deps.adapter.ensureIdentity(handle);
    const outcome = await deps.adapter.check(handle, decoded.facts.map(toPolicyFacts));
    deps.usage.record(did, outcome.verdict, decoded.source, decoded.facts.map((f) => f.kind), outcome.credits);
    res.json({ did, source: decoded.source, facts: decoded.facts, result: { verdict: outcome.verdict, hits: outcome.hits }, policySource: outcome.source, credits: outcome.credits, explanation: explain(decoded.facts, outcome) });
  }));

  app.get("/api/stats", wrap(async (_req, res) => res.json({ mode: deps.adapter.mode, ...deps.usage.stats() })));

  const isAdmin = (req: Request) => {
    const t = req.header("x-admin-token") ?? String(req.query.token ?? "");
    if (!deps.adminToken || !t) return false;
    const a = Buffer.from(t), b = Buffer.from(deps.adminToken);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  /** Submission export: every DID that used SignGuard (local record ∪ T3N activity log). */
  app.get("/api/admin/dids", wrap(async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "admin token required (set SIGNGUARD_ADMIN_TOKEN)" });
    const local = deps.usage.exportDids();
    const byDid = new Map(local.map((d) => [d.did, { ...d, t3nCalls: 0 }]));
    let logError: string | undefined;
    try {
      for (const r of await deps.adapter.activity({ max: 20000 })) {
        if (r.fn !== "check") continue;
        const e = byDid.get(r.onBehalfOf) ?? { did: r.onBehalfOf, firstSeen: new Date(r.ts).toISOString(), lastSeen: new Date(r.ts).toISOString(), checks: 0, t3nCalls: 0 };
        e.t3nCalls++;
        byDid.set(r.onBehalfOf, e);
      }
    } catch (e) {
      logError = (e as Error).message;
    }
    const rows = [...byDid.values()].sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
    if (req.query.format === "csv") {
      res.type("text/csv").attachment("signguard-dids.csv");
      return res.send(["did,first_seen,last_seen,checks,t3n_logged_calls", ...rows.map((r) => `${r.did},${r.firstSeen},${r.lastSeen},${r.checks},${r.t3nCalls}`)].join("\n") + "\n");
    }
    res.json({ mode: deps.adapter.mode, count: rows.length, logError, dids: rows });
  }));

  app.get("/api/admin/activity", wrap(async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "admin token required" });
    res.json(await deps.adapter.activity({ max: Number(req.query.max ?? 200) }));
  }));

  return app;
}
