/**
 * Real T3N adapter on @terminal3/t3n-sdk. Written against the SDK's published
 * types and the ADK docs (quickstart, member delegation, invoke, activity log).
 * NOT yet exercised live: it needs the API key from the claim page plus the
 * one-time setup in scripts/t3n-setup.ts (org, agent, contract, map).
 *
 * Identity model (v1): each browser gets a fresh random secp256k1 key — a
 * throwaway *identity* key, never a wallet that holds funds. It is generated
 * and kept server-side, encrypted at rest (AES-256-GCM, SIGNGUARD_KEY_SECRET),
 * so a follower can try SignGuard in one click with no wallet. v2 moves the
 * key into the browser (or SIWE with the user's own wallet).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Wallet } from "ethers";
import {
  T3nClient,
  setEnvironment,
  getNodeUrl,
  loadWasmComponent,
  resolveTrustAnchor,
  eth_get_address,
  metamask_sign,
  createEthAuthInput,
  getContractVersion,
  fanOutGrant,
  invoke,
  InvokeError,
  type BoundGrant,
} from "@terminal3/t3n-sdk";
import type { Rules, TxFacts, Verdict, Hit, ReasonCode } from "../../core/types.js";
import type { ActivityRow, AdapterStatus, CheckOutcome, Identity, T3nAdapter } from "./adapter.js";
import { JsonFile } from "../jsonfile.js";

export interface RealConfig {
  env: "testnet" | "production";
  /** Mari's developer key (tenant + org admin). Used only for admin reads (activity log). */
  devKey: string;
  /** Org-owned SignGuard agent: its API key + DID. */
  agentApiKey: string;
  agentDid: string;
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
  createdAt: number;
}

type WasmComponent = Awaited<ReturnType<typeof loadWasmComponent>>;

export class RealT3n implements T3nAdapter {
  readonly mode = "real" as const;
  private wasm: Promise<WasmComponent> | null = null;
  private trust: ReturnType<typeof resolveTrustAnchor> | null = null;
  private sessions = new Map<string, { client: T3nClient; did: string; at: number }>();
  private ids: JsonFile<{ users: Record<string, IdentityRecord> }>;
  private version: string | null = null;
  private aesKey: Buffer;

  constructor(private cfg: RealConfig) {
    setEnvironment(cfg.env);
    this.ids = new JsonFile(`${cfg.dataDir}/identities.json`, { users: {} });
    this.aesKey = createHash("sha256").update(cfg.keySecret).digest();
  }

  // ------------------------------------------------------------ plumbing

  private async base() {
    this.wasm ??= loadWasmComponent();
    this.trust ??= resolveTrustAnchor(this.cfg.env);
    return { wasmComponent: await this.wasm, trustAnchor: await this.trust };
  }

  private async session(privateKey: string): Promise<{ client: T3nClient; did: string }> {
    const { wasmComponent, trustAnchor } = await this.base();
    const address = eth_get_address(privateKey);
    const client = new T3nClient({ trustAnchor, wasmComponent, handlers: { EthSign: metamask_sign(address, undefined, privateKey) } });
    await client.handshake();
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
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached;
    const rec = this.ids.data.users[handle];
    if (!rec) throw new Error("unknown user — start a session first");
    const s = await this.session(this.decrypt(rec.enc));
    const entry = { ...s, at: Date.now() };
    this.sessions.set(handle, entry);
    return entry;
  }

  // ------------------------------------------------------------ adapter

  async ensureIdentity(handle: string): Promise<Identity> {
    const rec = this.ids.data.users[handle];
    if (rec) return { did: rec.did, created: false };
    const pk = Wallet.createRandom().privateKey;
    const s = await this.session(pk); // first sign-in mints the user's did:t3n
    this.ids.data.users[handle] = { did: s.did, enc: this.encrypt(pk), createdAt: Date.now() };
    this.ids.save(true);
    this.sessions.set(handle, { ...s, at: Date.now() });
    return { did: s.did, created: true };
  }

  async saveRules(handle: string, rules: Rules): Promise<void> {
    const rec = this.ids.data.users[handle];
    const { client } = await this.userSession(handle);
    const contract_version = await this.contractVersion();
    // Self call: the user writes their own rules into the TEE-private map.
    await client.executeAndDecode({ contract_id: this.cfg.contract, contract_version, function_name: "set_rules", input: { rules } });
    if (!rec.granted) {
      // The user lets the SignGuard agent call `check` — and nothing else.
      await client.updateMemberDelegation(
        fanOutGrant<BoundGrant>({ grantee: this.cfg.agentDid, contract_id: this.cfg.contract, scopes: [], allowed_hosts: [] }, ["check"]),
      );
      rec.granted = true;
    }
    rec.hasRules = true;
    this.ids.save(true);
  }

  async hasRules(handle: string): Promise<boolean> {
    return !!this.ids.data.users[handle]?.hasRules;
  }

  async check(handle: string, facts: TxFacts[]): Promise<CheckOutcome> {
    const rec = this.ids.data.users[handle];
    if (!rec) throw new Error("unknown user — start a session first");
    if (!rec.granted) throw new Error("save your rules first (this also authorises the SignGuard agent)");
    try {
      const res = await invoke<{ verdict: Verdict; codes: { code: ReasonCode; severity: "warn" | "block" }[] }>({
        baseUrl: getNodeUrl(),
        apiKey: this.cfg.agentApiKey,
        request: { contract_id: this.cfg.contract, contract_version: await this.contractVersion(), function_name: "check", pii_did: rec.did, input: { facts } },
      });
      const hits: Hit[] = (res.codes ?? []).map((c) => ({ code: c.code, severity: c.severity }));
      return { verdict: res.verdict, hits, source: "t3n-tee" };
    } catch (e) {
      if (e instanceof InvokeError) throw new Error(`T3N invoke failed (HTTP ${e.status ?? "?"})`);
      throw e;
    }
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
    return { mode: "real", network: this.cfg.env, ready, contract: this.cfg.contract, agentDid: this.cfg.agentDid, notes };
  }

  /** Org activity log, read as org admin with the developer key. */
  async activity(opts: { sinceMs?: number; max?: number } = {}): Promise<ActivityRow[]> {
    const { client } = await this.session(this.cfg.devKey);
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
