/**
 * Real T3N adapter on @terminal3/t3n-sdk. Written against the SDK's published
 * types and the ADK docs (quickstart, member delegation, invoke, activity log).
 * NOT yet exercised live: it needs the API key from the claim page plus the
 * one-time setup in scripts/t3n-setup.ts (org, agent, contract, map).
 *
 * Identity model:
 *  - "email" login (default for real mode): T3N's email-code sign-in
 *    (createEmailOtpAuthInput). T3N emails the visitor a code, the DID is keyed
 *    on the email (same email -> same DID), then `submitUserInput` (user-upsert)
 *    registers the profile, so the org can add + fund it. We then link a
 *    throwaway secp256k1 *device key* to that DID (`addAuthMethod`) so later
 *    sessions resume without another email. SignGuard never stores the email.
 *  - "anonymous" login (legacy / delegated experiments): a fresh device key
 *    per browser. T3N treats such wallet-only DIDs as non-users, so they can't
 *    be added to an org or sponsored.
 * Device keys never hold funds; they are kept server-side, encrypted at rest
 * (AES-256-GCM, SIGNGUARD_KEY_SECRET).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Wallet } from "ethers";
import {
  T3nClient,
  toBaseUnits,
  setEnvironment,
  getNodeUrl,
  loadWasmComponent,
  resolveTrustAnchor,
  eth_get_address,
  createEmailOtpAuthInput,
  metamask_sign,
  createEthAuthInput,
  getContractVersion,
  fanOutGrant,
  invoke,
  InvokeError,
  type BoundGrant,
} from "@terminal3/t3n-sdk";
import type { Rules, TxFacts, Verdict, Hit, ReasonCode } from "../../core/types.js";
import { SignInRequired, UserFacingError } from "./adapter.js";
import type { ActivityRow, AdapterStatus, CheckOutcome, EmailLoginDone, EmailLoginStart, Identity, LoginMethod, T3nAdapter } from "./adapter.js";
import { normalizeCode, normalizeEmail, PENDING_TTL_SECS, profileNames } from "./email.js";
import { JsonFile } from "../jsonfile.js";

/**
 * How a user's checks are paid for and attributed (see README "Credits"):
 *  - "self" (default): the org admin adds each new user DID to the SignGuard
 *    org and sponsors a few credits; the user's own session then calls
 *    set_rules / check directly (self calls need no delegation grant). Each
 *    user DID burns its own credits -> the grant's traction metric.
 *  - "delegated": the user grants the SignGuard agent `check` via member
 *    delegation and the agent pays. Needs the user to make a tee:user call,
 *    which testnet charges ~30 credits and requires ~10,000 credits available
 *    for (measured 2026-11-19), so a fresh 0-credit user cannot do it.
 */
export type UserMode = "self" | "delegated";

export interface RealConfig {
  env: "testnet" | "production";
  /** Mari's developer key (tenant + org admin). Admin calls: add member, fund, activity log. */
  devKey: string;
  /** SignGuard organisation (admin = devKey). Required for "self" mode sponsorship. */
  orgDid?: string;
  userMode: UserMode;
  /** How visitors sign in. Default "email" (needed for self-mode sponsorship). */
  loginMethod?: LoginMethod;
  /** Credits sponsored to a new user, and the per-user lifetime cap. */
  userCredits: number;
  userCreditCap: number;
  /** Total sponsorship per UTC day across all users. */
  dailyBudget: number;
  /** Org-owned SignGuard agent (only for "delegated" mode). */
  agentApiKey?: string;
  agentDid?: string;
  /** z:<tid>:signguard */
  contract: string;
  /** 32+ char secret used to encrypt burner identity keys at rest. */
  keySecret: string;
  dataDir: string;
}

interface IdentityRecord {
  did: string;
  enc: string; // iv.tag.ciphertext (hex)
  granted?: boolean;
  hasRules?: boolean;
  member?: boolean;
  sponsored?: number;
  sponsorError?: string;
  /** Email login: device key linked to the DID via addAuthMethod (resumable without email). */
  linked?: boolean;
  /** Email login: registered via user-upsert. */
  registered?: boolean;
  createdAt: number;
}

/** Sponsorship is tracked per DID (a returning user may sign in from several browsers). */
interface DidRecord {
  member?: boolean;
  sponsored?: number;
  registered?: boolean;
  hasRules?: boolean;
}

interface PendingEmail {
  client: T3nClient;
  pk: string;
  supplyCode: (code: string) => void;
  cancel: (e: Error) => void;
  auth: Promise<string>;
  expires: number;
  timer: ReturnType<typeof setTimeout>;
  /** Set once the code has been redeemed; later retries reuse this session. */
  did?: string;
}

/** T3N wants bare 40-hex DIDs in some inputs (e.g. user-upsert organisation_did). */
export const didHex = (did: string) => did.replace(/^did:t3n:/, "");

type WasmComponent = Awaited<ReturnType<typeof loadWasmComponent>>;

/** Turn known T3N refusals into something a user/operator can act on. */
export function explainT3nError(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (/can't attribute a non-user|does not exist/i.test(m))
    return "T3N only lets an org add *registered* users (email-verified via user-upsert); this wallet-only identity isn't one yet, so it can't be sponsored credits.";
  if (/insufficient.?credit/i.test(m)) return "Not enough T3N credits for this call.";
  if (/email_not_verified/i.test(m)) return "T3N wants a verified email before registering this identity.";
  if (/daily T3N credit budget/.test(m)) return m;
  return `T3N refused the call: ${m.replace(/t3n_key_\S+/g, "<redacted>").slice(0, 200)}`;
}

export class RealT3n implements T3nAdapter {
  readonly mode = "real" as const;
  get requiresRulesBeforeCheck() {
    return this.cfg.userMode === "delegated";
  }
  private wasm: Promise<WasmComponent> | null = null;
  private trust: ReturnType<typeof resolveTrustAnchor> | null = null;
  private sessions = new Map<string, { client: T3nClient; did: string; at: number }>();
  private ids: JsonFile<{ users: Record<string, IdentityRecord>; dids?: Record<string, DidRecord> }>;
  private pending = new Map<string, PendingEmail>();
  readonly loginMethod: LoginMethod;
  private version: string | null = null;
  private aesKey: Buffer;
  private admin: { client: T3nClient; did: string; at: number } | null = null;
  private budget: JsonFile<{ day: string; spent: number; total: number }>;

  constructor(private cfg: RealConfig) {
    setEnvironment(cfg.env);
    if (cfg.userMode === "self" && !cfg.orgDid) throw new Error("T3N_ORG_DID is required for self mode");
    if (cfg.userMode === "delegated" && !(cfg.agentApiKey && cfg.agentDid)) throw new Error("T3N_AGENT_API_KEY and T3N_AGENT_DID are required for delegated mode");
    this.ids = new JsonFile(`${cfg.dataDir}/identities.json`, { users: {} });
    this.budget = new JsonFile(`${cfg.dataDir}/sponsor-budget.json`, { day: "", spent: 0, total: 0 });
    this.aesKey = createHash("sha256").update(cfg.keySecret).digest();
    this.loginMethod = cfg.loginMethod ?? "email";
  }

  private didRec(did: string): DidRecord {
    const all = (this.ids.data.dids ??= {});
    if (!all[did]) {
      // Migrate state that older records kept per handle.
      const old = Object.values(this.ids.data.users).filter((u) => u.did === did);
      all[did] = {
        member: old.some((u) => u.member) || undefined,
        sponsored: old.reduce((n, u) => n + (u.sponsored ?? 0), 0) || undefined,
        hasRules: old.some((u) => u.hasRules) || undefined,
      };
    }
    return all[did];
  }

  // ------------------------------------------------------------ plumbing

  private async base() {
    this.wasm ??= loadWasmComponent();
    this.trust ??= resolveTrustAnchor(this.cfg.env);
    return { wasmComponent: await this.wasm, trustAnchor: await this.trust };
  }

  /** A handshaken client whose EthSign handler signs with `privateKey`. */
  private async newClient(privateKey: string): Promise<T3nClient> {
    const { wasmComponent, trustAnchor } = await this.base();
    const address = eth_get_address(privateKey);
    const client = new T3nClient({ trustAnchor, wasmComponent, handlers: { EthSign: metamask_sign(address, undefined, privateKey) } });
    await client.handshake();
    return client;
  }

  private async session(privateKey: string): Promise<{ client: T3nClient; did: string }> {
    const address = eth_get_address(privateKey);
    const client = await this.newClient(privateKey);
    const did = await client.authenticate(createEthAuthInput(address));
    return { client, did: did.value }; // Did object -> .value (docs: never derive a DID)
  }

  private async contractVersion(): Promise<string> {
    this.version ??= await getContractVersion(getNodeUrl(), this.cfg.contract);
    return this.version;
  }

  private encrypt(pk: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.aesKey, iv);
    const ct = Buffer.concat([c.update(pk, "utf8"), c.final()]);
    return [iv.toString("hex"), c.getAuthTag().toString("hex"), ct.toString("hex")].join(".");
  }

  private decrypt(enc: string): string {
    const [iv, tag, ct] = enc.split(".").map((h) => Buffer.from(h, "hex"));
    const d = createDecipheriv("aes-256-gcm", this.aesKey, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  }

  private async userSession(handle: string) {
    const cached = this.sessions.get(handle);
    const rec = this.ids.data.users[handle];
    if (!rec) throw new SignInRequired();
    // Email logins whose device key isn't linked can only live as long as the email session.
    const emailOnly = this.loginMethod === "email" && !rec.linked;
    if (cached && Date.now() - cached.at < (emailOnly ? 50 : 10) * 60_000) return cached;
    if (emailOnly) {
      this.sessions.delete(handle);
      throw new SignInRequired("Your sign-in expired. Enter your email again to get a new code.");
    }
    const s = await this.session(this.decrypt(rec.enc));
    if (s.did !== rec.did) throw new SignInRequired("This device key no longer maps to your identity. Sign in with your email again.");
    const entry = { ...s, at: Date.now() };
    this.sessions.set(handle, entry);
    return entry;
  }

  private async adminSession() {
    if (this.admin && Date.now() - this.admin.at < 10 * 60_000) return this.admin;
    const s = await this.session(this.cfg.devKey);
    this.admin = { ...s, at: Date.now() };
    return this.admin;
  }

  /** Org admin adds the user to the SignGuard org (once) and sponsors credits, within caps. */
  private async sponsor(did: string): Promise<boolean> {
    if (this.cfg.userMode !== "self") return false;
    const rec = this.didRec(did);
    const today = new Date().toISOString().slice(0, 10);
    const b = this.budget.data;
    if (b.day !== today) { b.day = today; b.spent = 0; }
    const amount = this.cfg.userCredits;
    if ((rec.sponsored ?? 0) + amount > this.cfg.userCreditCap) return false;
    if (b.spent + amount > this.cfg.dailyBudget) throw new Error("SignGuard's free daily T3N credit budget is used up — try again tomorrow");
    const { client } = await this.adminSession();
    if (!rec.member) {
      try {
        await client.addOrganisationMember(this.cfg.orgDid!, did);
      } catch (e) {
        // user-upsert with organisationDid may already have attached them.
        if (!/already/i.test(String((e as Error)?.message ?? e))) throw e;
      }
      rec.member = true;
      await this.ids.persist();
    }
    // Record the gift durably *before* sending it, so a crash/restart can never
    // re-gift (worst case a gift is recorded but not sent; the user can top up).
    rec.sponsored = (rec.sponsored ?? 0) + amount;
    b.spent += amount;
    b.total += amount;
    await Promise.all([this.ids.persist(), this.budget.persist()]);
    try {
      await client.fundAgent(did, toBaseUnits(amount), { note: "signguard user sponsorship" });
    } catch (e) {
      // T3N refused the transfer: undo the record so the user isn't stuck.
      rec.sponsored = (rec.sponsored ?? 0) - amount || undefined;
      b.spent -= amount;
      b.total -= amount;
      await Promise.all([this.ids.persist(), this.budget.persist()]).catch(() => {});
      throw e;
    }
    return true;
  }

  /** Run a user-paid call; on InsufficientCredit, sponsor once (within caps) and retry. */
  private async withCredits<T>(rec: { did: string }, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!/insufficient.?credit/i.test(String((e as Error)?.message ?? e))) throw e;
      let ok: boolean;
      try {
        ok = await this.sponsor(rec.did);
      } catch (se) {
        throw new Error(explainT3nError(se));
      }
      if (!ok) throw new Error("This identity has used its free T3N credits");
      return await fn();
    }
  }

  // ------------------------------------------------------------ adapter

  /**
   * Email sign-in, step 1. Starts T3N's email-OTP login on a fresh client; the
   * SDK calls `getOtpCode` once T3N has emailed the code, and we park the login
   * until step 2 supplies it (or 10 minutes pass).
   */
  async startEmailLogin(rawEmail: string): Promise<EmailLoginStart> {
    if (this.loginMethod !== "email") throw new UserFacingError("Email sign-in is off on this server.");
    const email = normalizeEmail(rawEmail);
    const pk = Wallet.createRandom().privateKey; // device key, linked after sign-in
    const client = await this.newClient(pk);
    let supplyCode!: (c: string) => void;
    let cancel!: (e: Error) => void;
    const codeP = new Promise<string>((res, rej) => { supplyCode = res; cancel = rej; });
    let sent!: () => void;
    const sentP = new Promise<void>((res) => (sent = res));
    const auth = client
      .authenticate(createEmailOtpAuthInput({ email, getOtpCode: () => { sent(); return codeP; } }))
      .then((d) => d.value);
    auth.catch(() => {}); // observed below / in verify
    try {
      await Promise.race([sentP, auth.then(() => { throw new Error("T3N signed in without asking for a code"); })]);
    } catch (e) {
      throw mapLoginError(e);
    }
    const pendingId = randomBytes(16).toString("hex");
    const timer = setTimeout(() => {
      const p = this.pending.get(pendingId);
      if (p) { this.pending.delete(pendingId); p.cancel(new Error("expired")); }
    }, PENDING_TTL_SECS * 1000);
    timer.unref?.();
    this.pending.set(pendingId, { client, pk, supplyCode, cancel, auth, expires: Date.now() + PENDING_TTL_SECS * 1000, timer });
    return { pendingId, expiresInSec: PENDING_TTL_SECS };
  }

  /**
   * Email sign-in, step 2: finish the login, register the profile (user-upsert,
   * attributed to our org), add the DID to the org + sponsor credits, then link
   * the device key so the browser can resume later without email.
   */
  async verifyEmailLogin(pendingId: string, rawCode: string, name?: string): Promise<EmailLoginDone> {
    const code = normalizeCode(rawCode);
    const p = this.pending.get(String(pendingId));
    if (!p || p.expires < Date.now()) throw new UserFacingError("That code expired. Request a new one.", 410);
    if (!p.did) {
      p.supplyCode(code);
      try {
        p.did = await p.auth;
      } catch (e) {
        // The SDK login is single-shot: a refused code ends it, so ask for a new one.
        this.pending.delete(String(pendingId));
        clearTimeout(p.timer);
        throw mapLoginError(e, true);
      }
    }
    // From here on the email is proven: if a later step fails, the pending login
    // stays parked so "Verify" can be retried without a new email.
    const did = p.did;
    const notes: string[] = [];
    const drec = this.didRec(did);
    const created = !drec.registered && !drec.member;
    // 1) Register (user-upsert). Testnet ran user-upsert for a 0-credit DID
    //    (it answered email_not_verified, not InsufficientCredit), so we expect
    //    registration to be free; if it isn't, there's no way to pre-fund a
    //    non-user, so surface it clearly.
    if (!drec.registered) {
      try {
        await p.client.submitUserInput({ profile: profileNames(name), ...(this.cfg.orgDid ? { organisationDid: didHex(this.cfg.orgDid) } : {}) });
      } catch (e) {
        const m = String((e as Error)?.message ?? e);
        if (/insufficient.?credit/i.test(m)) throw new UserFacingError("Terminal 3 wants credits to register new users, and SignGuard can only fund registered users. We're on it — please try again later.", 503);
        throw new UserFacingError(`${explainT3nError(e)} Your email is verified — press Verify again to retry (no new code needed).`, 502);
      }
      drec.registered = true;
      this.ids.save(true);
    }
    // 2) Org membership + sponsored credits (self mode), within caps.
    let sponsored: number | undefined;
    try {
      const before = drec.sponsored ?? 0;
      if (!drec.sponsored) await this.sponsor(did);
      if ((drec.sponsored ?? 0) > before) sponsored = (drec.sponsored ?? 0) - before;
    } catch (e) {
      notes.push(explainT3nError(e));
    }
    // 3) Link the device key so later sessions resume without another email.
    const handle = randomBytes(16).toString("hex");
    const rec: IdentityRecord = { did, enc: this.encrypt(p.pk), registered: true, createdAt: Date.now() };
    try {
      await p.client.addAuthMethod(createEthAuthInput(eth_get_address(p.pk)));
      rec.linked = true;
    } catch (e) {
      notes.push(`Couldn't link a device key (${explainT3nError(e)}); you'll need a new email code when this session expires.`);
    }
    this.ids.data.users[handle] = rec;
    this.ids.save(true);
    this.sessions.set(handle, { client: p.client, did, at: Date.now() });
    this.pending.delete(String(pendingId));
    clearTimeout(p.timer);
    return { handle, did, created, sponsored, notes: notes.length ? notes : undefined };
  }

  async isSignedIn(handle: string): Promise<boolean> {
    const rec = this.ids.data.users[handle];
    if (!rec) return false;
    if (this.loginMethod !== "email" || rec.linked) return true;
    const s = this.sessions.get(handle);
    return !!s && Date.now() - s.at < 50 * 60_000;
  }

  async ensureIdentity(handle: string): Promise<Identity> {
    const rec = this.ids.data.users[handle];
    if (rec) return { did: rec.did, created: false };
    if (this.loginMethod === "email") throw new SignInRequired();
    const pk = Wallet.createRandom().privateKey;
    const s = await this.session(pk); // first sign-in mints the user's did:t3n
    const fresh: IdentityRecord = { did: s.did, enc: this.encrypt(pk), createdAt: Date.now() };
    this.ids.data.users[handle] = fresh;
    this.ids.save(true);
    this.sessions.set(handle, { ...s, at: Date.now() });
    // New DIDs start at 0 credits (verified on testnet), so sponsor up front.
    // Don't fail the session if T3N refuses; check() surfaces a clear error.
    try {
      await this.sponsor(fresh.did);
    } catch (e) {
      fresh.sponsorError = explainT3nError(e);
      this.ids.save(true);
    }
    return { did: s.did, created: true };
  }

  async saveRules(handle: string, rules: Rules): Promise<void> {
    const rec = this.ids.data.users[handle];
    if (!rec) throw new SignInRequired();
    const { client } = await this.userSession(handle);
    const contract_version = await this.contractVersion();
    // Self call: the user writes their own rules into the TEE-private map.
    // WIT export `set-rules` (kebab-case, as declared in contracts/.../world.wit).
    await this.withCredits(rec, () => client.executeAndDecode({ contract_id: this.cfg.contract, contract_version, function_name: "set-rules", input: { rules } }));
    if (this.cfg.userMode === "delegated" && !rec.granted) {
      // The user lets the SignGuard agent call `check` — and nothing else.
      await client.updateMemberDelegation(
        fanOutGrant<BoundGrant>({ grantee: this.cfg.agentDid!, contract_id: this.cfg.contract, scopes: [], allowed_hosts: [] }, ["check"]),
      );
      rec.granted = true;
    }
    rec.hasRules = true;
    this.didRec(rec.did).hasRules = true;
    this.ids.save(true);
  }

  async hasRules(handle: string): Promise<boolean> {
    const rec = this.ids.data.users[handle];
    return !!rec && (!!rec.hasRules || !!this.didRec(rec.did).hasRules);
  }

  async check(handle: string, facts: TxFacts[]): Promise<CheckOutcome> {
    const rec = this.ids.data.users[handle];
    if (!rec) throw new SignInRequired();
    type Res = { verdict: Verdict; codes: { code: ReasonCode; severity: "warn" | "block" }[] };
    const contract_version = await this.contractVersion();
    let res: Res;
    if (this.cfg.userMode === "self") {
      // Self call by the user's own DID: no grant needed; billed to (and logged for) that DID.
      const { client } = await this.userSession(handle);
      res = await this.withCredits(rec, () => client.executeAndDecode<Res>({ contract_id: this.cfg.contract, contract_version, function_name: "check", input: { facts } }));
    } else {
      if (!rec.granted) throw new Error("save your rules first (this also authorises the SignGuard agent)");
      try {
        res = await invoke<Res>({
          baseUrl: getNodeUrl(),
          apiKey: this.cfg.agentApiKey!,
          request: { contract_id: this.cfg.contract, contract_version, function_name: "check", pii_did: rec.did, input: { facts } },
        });
      } catch (e) {
        if (e instanceof InvokeError) throw new Error(`T3N invoke failed (HTTP ${e.status ?? "?"})`);
        throw e;
      }
    }
    const hits: Hit[] = (res.codes ?? []).map((c) => ({ code: c.code, severity: c.severity }));
    return { verdict: res.verdict, hits, source: "t3n-tee" };
  }

  async status(): Promise<AdapterStatus> {
    const notes: string[] = [];
    let ready = true;
    try {
      await this.contractVersion();
    } catch (e) {
      ready = false;
      notes.push(`Contract ${this.cfg.contract} not reachable: ${(e as Error).message}`);
    }
    notes.push(`Sign-in: ${this.loginMethod === "email" ? "email code (T3N email-OTP + user-upsert)" : "anonymous device key"}`);
    notes.push(`User mode: ${this.cfg.userMode}${this.cfg.userMode === "self" ? ` (sponsoring ${this.cfg.userCredits} credits per new user, cap ${this.cfg.userCreditCap}, daily budget ${this.cfg.dailyBudget})` : ""}`);
    return { mode: "real", network: this.cfg.env, ready, contract: this.cfg.contract, agentDid: this.cfg.agentDid, notes };
  }

  /** Org activity log, read as org admin with the developer key. */
  async activity(opts: { sinceMs?: number; max?: number } = {}): Promise<ActivityRow[]> {
    const { client } = await this.adminSession();
    const out: ActivityRow[] = [];
    let cursor: number | undefined;
    const max = opts.max ?? 5000;
    do {
      const page = await client.getActivityLog({ limit: 500, custom: { sg_op: "check" }, ...(opts.sinceMs ? { from_ms: opts.sinceMs } : {}), ...(cursor !== undefined ? { before_seq: cursor } : {}) });
      for (const e of page.entries) out.push({ seq: e.seq_no, ts: e.timestamp_ms, actor: e.actor, onBehalfOf: e.on_behalf_of, fn: e.function, outcome: e.outcome, labels: e.custom, hash: e.hash });
      cursor = page.next_seq ?? undefined; // page until next_seq is null (docs warning)
    } while (cursor !== undefined && out.length < max);
    return out;
  }
}

/** Map SDK login failures to messages a visitor can act on. */
function mapLoginError(e: unknown, afterCode = false): Error {
  if (e instanceof UserFacingError) return e;
  const err = e as { name?: string; retryAfterSecs?: number; message?: string };
  const m = String(err?.message ?? e);
  if (err?.name === "OtpRateLimitedError" || /cooldown_active|send_cap_exceeded|rate.?limit/i.test(m)) {
    const wait = typeof err.retryAfterSecs === "number" ? err.retryAfterSecs : undefined;
    return new UserFacingError(`You just asked for a code${wait ? ` — try again in ${wait}s` : " — try again in a minute"}.`, 429, wait);
  }
  if (afterCode) return new UserFacingError("That code didn't work (wrong or expired). Request a new code and try again.");
  return new UserFacingError(`Couldn't send a code: ${m.replace(/t3n_key_\S+/g, "<redacted>").slice(0, 160)}`, 502);
}
