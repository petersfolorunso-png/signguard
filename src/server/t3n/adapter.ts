/**
 * The one seam between SignGuard and Terminal 3 (T3N).
 *
 *  - Every user gets their own `did:t3n`, via T3N's email-code sign-in
 *    (registered with user-upsert so the org can add + sponsor it).
 *  - Their rules live in a private T3N map, readable only by our TEE contract.
 *  - Each check is a TEE contract self call by the user's DID ("self" mode),
 *    billed to that DID and recorded in T3N's tamper-evident activity log
 *    <- the traction metric.
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

/** How visitors get their did:t3n. */
export type LoginMethod = "anonymous" | "email";

export interface EmailLoginStart {
  pendingId: string;
  expiresInSec: number;
  /** Mock mode only: the code to type (no email is ever sent in mock mode). */
  demoCode?: string;
}

export interface EmailLoginDone extends Identity {
  handle: string;
  /** Credits sponsored on first sign-in, if any. */
  sponsored?: number;
  /** Non-fatal onboarding notes (e.g. couldn't link a device key). */
  notes?: string[];
}

/** Thrown when an action needs a signed-in user (maps to HTTP 401). */
export class SignInRequired extends Error {
  constructor(msg = "Sign in with your email to use your private Terminal 3 vault.") {
    super(msg);
    this.name = "SignInRequired";
  }
}

/** A user-facing refusal (maps to HTTP 400/429). Message is safe to show. */
export class UserFacingError extends Error {
  constructor(msg: string, public status = 400, public retryAfterSecs?: number) {
    super(msg);
    this.name = "UserFacingError";
  }
}

export interface T3nAdapter {
  readonly loginMethod: LoginMethod;
  /** Email sign-in step 1: T3N emails a one-time code (mock: returns demoCode). */
  startEmailLogin(email: string): Promise<EmailLoginStart>;
  /** Email sign-in step 2: verify the code, register the user, add to org + sponsor credits. */
  verifyEmailLogin(pendingId: string, code: string): Promise<EmailLoginDone>;
  /** Is this handle signed in (resumable) right now? */
  isSignedIn(handle: string): Promise<boolean>;
  readonly mode: "mock" | "real";
  /**
   * True when check() needs rules saved first (delegated mode: saving also
   * grants the agent). Otherwise the TEE falls back to default rules, which
   * saves a ~90-credit set-rules call for users who never customise.
   */
  readonly requiresRulesBeforeCheck: boolean;
  /**
   * Anonymous mode: get (or mint) the did:t3n for a browser handle.
   * Email mode: return the DID for a signed-in handle, else throw SignInRequired.
   */
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
