import { createHash, randomBytes } from "node:crypto";
import { evaluate } from "../../core/rules.js";
import type { Rules, TxFacts } from "../../core/types.js";
import { DEFAULT_RULES } from "../../core/rules.js";
import type { ActivityRow, AdapterStatus, CheckOutcome, Identity, T3nAdapter } from "./adapter.js";
import { JsonFile } from "../jsonfile.js";

interface MockState {
  identities: Record<string, { did: string; createdAt: number }>;
  /** Stand-in for the TEE-sealed map. Real mode never stores rules on our server. */
  vault: Record<string, Rules>;
  log: ActivityRow[];
}

/** Mock credit price per check, purely illustrative. */
export const MOCK_CREDITS_PER_CHECK = 0.01;
const MOCK_AGENT = "did:t3n:mock-agent-signguard";

export class MockT3n implements T3nAdapter {
  readonly mode = "mock" as const;
  private file: JsonFile<MockState>;

  constructor(path: string) {
    this.file = new JsonFile<MockState>(path, { identities: {}, vault: {}, log: [] });
  }

  async ensureIdentity(handle: string): Promise<Identity> {
    const s = this.file.data;
    const existing = s.identities[handle];
    if (existing) return { did: existing.did, created: false };
    // Real DIDs are opaque ids assigned by T3N; mock ones are random + clearly labelled.
    const did = `did:t3n:mock${randomBytes(18).toString("hex")}`;
    s.identities[handle] = { did, createdAt: Date.now() };
    this.log(did, did, "identity-create", "success");
    this.file.save();
    return { did, created: true };
  }

  private didOf(handle: string): string {
    const id = this.file.data.identities[handle];
    if (!id) throw new Error("unknown user — start a session first");
    return id.did;
  }

  async saveRules(handle: string, rules: Rules): Promise<void> {
    const did = this.didOf(handle);
    this.file.data.vault[did] = rules;
    this.log(did, did, "set_rules", "success", { sg_op: "set_rules" });
    this.file.save();
  }

  async hasRules(handle: string): Promise<boolean> {
    return !!this.file.data.vault[this.didOf(handle)];
  }

  async check(handle: string, facts: TxFacts[]): Promise<CheckOutcome> {
    const did = this.didOf(handle);
    const rules = this.file.data.vault[did] ?? DEFAULT_RULES;
    const r = evaluate(facts, rules);
    this.log(MOCK_AGENT, did, "check", "success", { sg_op: "check", verdict: r.verdict, codes: r.hits.map((h) => h.code).join(",").slice(0, 128) });
    this.file.save();
    return { ...r, credits: MOCK_CREDITS_PER_CHECK, source: "mock-tee" };
  }

  async status(): Promise<AdapterStatus> {
    return {
      mode: "mock",
      network: "local-mock",
      ready: true,
      agentDid: MOCK_AGENT,
      notes: ["Mock mode: DIDs, the private vault and the activity log are simulated locally. Add T3N credentials to switch to real T3N."],
    };
  }

  async activity(opts: { sinceMs?: number; max?: number } = {}): Promise<ActivityRow[]> {
    return this.file.data.log.filter((r) => !opts.sinceMs || r.ts >= opts.sinceMs).slice(-(opts.max ?? 1000)).reverse();
  }

  flush() {
    this.file.flush();
  }

  private log(actor: string, onBehalfOf: string, fn: string, outcome: string, labels?: Record<string, string>) {
    const prev = this.file.data.log.at(-1)?.hash ?? "";
    const row: ActivityRow = { seq: this.file.data.log.length + 1, ts: Date.now(), actor, onBehalfOf, fn, outcome, labels };
    // Hash-chained like the real ledger, so the mock log is tamper-evident too.
    row.hash = createHash("sha256").update(prev + JSON.stringify(row)).digest("hex");
    this.file.data.log.push(row);
    if (this.file.data.log.length > 20000) this.file.data.log.splice(0, this.file.data.log.length - 20000);
  }
}
