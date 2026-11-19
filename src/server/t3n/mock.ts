import { createHash, randomBytes } from "node:crypto";
import { evaluate } from "../../core/rules.js";
import type { Rules, TxFacts } from "../../core/types.js";
import { DEFAULT_RULES } from "../../core/rules.js";
import { SignInRequired, UserFacingError } from "./adapter.js";
import type { ActivityRow, AdapterStatus, CheckOutcome, EmailLoginDone, EmailLoginStart, Identity, LoginMethod, T3nAdapter } from "./adapter.js";
import { normalizeCode, normalizeEmail, PENDING_TTL_SECS } from "./email.js";
import { JsonFile } from "../jsonfile.js";

interface MockState {
  identities: Record<string, { did: string; createdAt: number }>;
  /** Email mode: sha256(salt+email) -> DID, so the same email resolves to the same DID (like T3N). Emails are never stored. */
  emailDids?: Record<string, string>;
  salt?: string;
  /** Stand-in for the TEE-sealed map. Real mode never stores rules on our server. */
  vault: Record<string, Rules>;
  log: ActivityRow[];
}

/** Mock credit price per check, purely illustrative. */
export const MOCK_CREDITS_PER_CHECK = 0.01;
const MOCK_AGENT = "did:t3n:mock-agent-signguard";

export class MockT3n implements T3nAdapter {
  readonly mode = "mock" as const;
  readonly requiresRulesBeforeCheck = false;
  private file: JsonFile<MockState>;

  readonly loginMethod: LoginMethod;
  private pending = new Map<string, { emailKey: string; code: string; expires: number; tries: number }>();

  constructor(path: string, opts: { loginMethod?: LoginMethod } = {}) {
    this.file = new JsonFile<MockState>(path, { identities: {}, vault: {}, log: [] });
    this.loginMethod = opts.loginMethod ?? "anonymous";
  }

  /** Simulated email sign-in: nothing is sent; the code comes back as `demoCode` for the UI to show. */
  async startEmailLogin(rawEmail: string): Promise<EmailLoginStart> {
    const email = normalizeEmail(rawEmail);
    const s = this.file.data;
    s.salt ??= randomBytes(16).toString("hex");
    const emailKey = createHash("sha256").update(s.salt + email).digest("hex");
    const code = String(100000 + (randomBytes(4).readUInt32BE() % 900000));
    const pendingId = randomBytes(16).toString("hex");
    this.pending.set(pendingId, { emailKey, code, expires: Date.now() + PENDING_TTL_SECS * 1000, tries: 0 });
    return { pendingId, expiresInSec: PENDING_TTL_SECS, demoCode: code };
  }

  async verifyEmailLogin(pendingId: string, rawCode: string): Promise<EmailLoginDone> {
    const code = normalizeCode(rawCode);
    const p = this.pending.get(String(pendingId));
    if (!p || p.expires < Date.now()) {
      this.pending.delete(String(pendingId));
      throw new UserFacingError("That code expired. Request a new one.", 410);
    }
    if (code !== p.code) {
      if (++p.tries >= 5) this.pending.delete(String(pendingId));
      throw new UserFacingError("That code didn't match. Check the email and try again.");
    }
    this.pending.delete(String(pendingId));
    const s = this.file.data;
    s.emailDids ??= {};
    let did = s.emailDids[p.emailKey];
    const created = !did;
    if (!did) {
      did = `did:t3n:mock${randomBytes(18).toString("hex")}`;
      s.emailDids[p.emailKey] = did;
      this.log(did, did, "user-upsert", "success");
    }
    const handle = randomBytes(16).toString("hex");
    s.identities[handle] = { did, createdAt: Date.now() };
    this.file.save();
    return { handle, did, created, sponsored: created ? 1 : undefined };
  }

  async isSignedIn(handle: string): Promise<boolean> {
    return !!this.file.data.identities[handle];
  }

  async ensureIdentity(handle: string): Promise<Identity> {
    const s = this.file.data;
    const existing = s.identities[handle];
    if (existing) return { did: existing.did, created: false };
    if (this.loginMethod === "email") throw new SignInRequired();
    // Real DIDs are opaque ids assigned by T3N; mock ones are random + clearly labelled.
    const did = `did:t3n:mock${randomBytes(18).toString("hex")}`;
    s.identities[handle] = { did, createdAt: Date.now() };
    this.log(did, did, "identity-create", "success");
    this.file.save();
    return { did, created: true };
  }

  private didOf(handle: string): string {
    const id = this.file.data.identities[handle];
    if (!id) throw new SignInRequired();
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
      notes: [
        ...(this.loginMethod === "email" ? ["Mock email sign-in: no email is sent; the code is shown on screen."] : []),
        "Mock mode: DIDs, the private vault and the activity log are simulated locally. Add T3N credentials to switch to real T3N.",
      ],
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
