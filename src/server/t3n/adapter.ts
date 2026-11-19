/**
 * The one seam between SignGuard and Terminal 3 (T3N).
 *
 *  - Every user gets their own `did:t3n` (their identity on T3N).
 *  - Their rules live in a private T3N map, readable only by our TEE contract.
 *  - Each check is a TEE contract call made by the SignGuard agent on the
 *    user's behalf (pii_did = user DID). The agent pays the credits, and the
 *    call lands in T3N's tamper-evident activity log as
 *    actor = agent, on_behalf_of = user DID.  <- the traction metric.
 *
 * `MockT3n` simulates all of this locally so the app runs before a key exists.
 */
import type { PolicyResult, Rules, TxFacts } from "../../core/types.js";

export interface Identity {
  did: string;
  created: boolean;
}

export interface CheckOutcome extends PolicyResult {
  /** Credits this call consumed, in whole credits, if known. */
  credits?: number;
  /** Where the verdict came from. */
  source: "t3n-tee" | "mock-tee";
}

export interface AdapterStatus {
  mode: "mock" | "real";
  network: string;
  ready: boolean;
  contract?: string;
  agentDid?: string;
  notes: string[];
}

export interface ActivityRow {
  seq?: number;
  ts: number;
  actor: string;
  onBehalfOf: string;
  fn: string;
  outcome: string;
  labels?: Record<string, string>;
  hash?: string;
}

export interface T3nAdapter {
  readonly mode: "mock" | "real";
  /**
   * True when check() needs rules saved first (delegated mode: saving also
   * grants the agent). Otherwise the TEE falls back to default rules, which
   * saves a ~90-credit set-rules call for users who never customise.
   */
  readonly requiresRulesBeforeCheck: boolean;
  /** Get (or mint on first use) the user's did:t3n for an opaque browser handle. */
  ensureIdentity(handle: string): Promise<Identity>;
  /** Store the user's private rules in their T3N vault (self call) and grant our agent `check`. */
  saveRules(handle: string, rules: Rules): Promise<void>;
  hasRules(handle: string): Promise<boolean>;
  /** Ask the TEE policy for a verdict on behalf of the user. Returns verdict + codes only. */
  check(handle: string, facts: TxFacts[]): Promise<CheckOutcome>;
  status(): Promise<AdapterStatus>;
  /** Org activity log rows for SignGuard checks (admin view). */
  activity(opts?: { sinceMs?: number; max?: number }): Promise<ActivityRow[]>;
}
