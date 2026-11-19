/**
 * The policy. This TypeScript version is the reference implementation used in
 * mock mode and in tests; contracts/signguard-policy/src/logic.rs is the same
 * logic for the T3N TEE. Both are checked against test-vectors/policy.json.
 *
 * Input: facts about a tx + the user's private rules. Output: verdict + reason
 * codes only. Thresholds and allowlist entries are never echoed back.
 */
import type { Hit, PolicyResult, ReasonCode, Rules, TxFacts, Verdict } from "./types.js";

export const DEFAULT_RULES: Rules = {
  blockUnlimitedApprovals: true,
  blockApprovalForAll: true,
  maxSpendUsd: 1000,
  maxLeverage: 10,
  allowlist: [],
  unlistedContract: "warn",
  permitSignatures: "warn",
  maxPermitDays: 30,
};

const APPROVALISH = new Set(["approve", "increaseAllowance", "permit", "permit2", "setApprovalForAll"]);
const SPENDISH = new Set(["approve", "increaseAllowance", "permit", "permit2", "transfer", "transferFrom", "native_transfer", "perp_open", "contract_call"]);

const RANK: Record<Verdict, number> = { allow: 0, warn: 1, block: 2 };
export const worst = (a: Verdict, b: Verdict): Verdict => (RANK[a] >= RANK[b] ? a : b);

/** Validate + normalise rules coming from a user/UI. Throws on nonsense. */
export function normalizeRules(input: Partial<Rules> | undefined): Rules {
  const r = { ...DEFAULT_RULES, ...(input ?? {}) };
  const num = (v: unknown, name: string): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a positive number or empty`);
    return n;
  };
  const mode = <T extends string>(v: unknown, allowed: readonly T[], name: string): T => {
    if (!allowed.includes(v as T)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
    return v as T;
  };
  const allow = Array.isArray(r.allowlist) ? r.allowlist : String(r.allowlist ?? "").split(/[\s,]+/);
  const allowlist = [...new Set(allow.map((a) => String(a).trim().toLowerCase()).filter(Boolean))];
  for (const a of allowlist) if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`allowlist entry is not an address: ${a.slice(0, 50)}`);
  if (allowlist.length > 200) throw new Error("allowlist is limited to 200 addresses");
  return {
    blockUnlimitedApprovals: Boolean(r.blockUnlimitedApprovals),
    blockApprovalForAll: Boolean(r.blockApprovalForAll),
    maxSpendUsd: num(r.maxSpendUsd, "maxSpendUsd"),
    maxLeverage: num(r.maxLeverage, "maxLeverage"),
    allowlist,
    unlistedContract: mode(r.unlistedContract, ["ignore", "warn", "block"] as const, "unlistedContract"),
    permitSignatures: mode(r.permitSignatures, ["ignore", "warn", "block"] as const, "permitSignatures"),
    maxPermitDays: num(r.maxPermitDays, "maxPermitDays"),
  };
}

/** Strip UI-only fields before facts leave the browser/server for the policy. */
export function toPolicyFacts(f: TxFacts): TxFacts {
  const { notes: _n, ...rest } = f;
  return rest;
}

export function evaluateOne(f: TxFacts, rules: Rules, nowSecs: number): Hit[] {
  const hits: Hit[] = [];
  const add = (code: ReasonCode, severity: "warn" | "block") => {
    if (!hits.some((h) => h.code === code && RANK[h.severity] >= RANK[severity])) {
      const i = hits.findIndex((h) => h.code === code);
      if (i >= 0) hits.splice(i, 1);
      hits.push({ code, severity });
    }
  };
  const allow = new Set(rules.allowlist.map((a) => a.toLowerCase()));
  const counterparty = (f.spender ?? (f.kind === "transfer" || f.kind === "native_transfer" ? f.recipient : f.target))?.toLowerCase();
  const allowlisted = !!counterparty && allow.has(counterparty);
  const approvalish = APPROVALISH.has(f.kind);

  if (f.kind === "unknown") add("undecodable", "warn");

  // 1. Unlimited approvals / permits.
  if (approvalish && f.unlimited && f.kind !== "setApprovalForAll") {
    if (rules.blockUnlimitedApprovals) add("unlimited_approval", allowlisted ? "warn" : "block");
  }

  // 2. Operator over *all* NFTs / outcome tokens.
  if (f.kind === "setApprovalForAll" && f.approvalForAll && rules.blockApprovalForAll) {
    add("approval_for_all", allowlisted ? "warn" : "block");
  }

  // 3. Spend cap.
  if (rules.maxSpendUsd !== null && SPENDISH.has(f.kind)) {
    if (f.unlimited) add("spend_over_cap", "block");
    else if (f.amountUsd !== undefined) {
      if (f.amountUsd > rules.maxSpendUsd) add("spend_over_cap", "block");
    } else if (f.amountRaw !== undefined || f.amount !== undefined) add("spend_unpriced", "warn");
  }

  // 4. Leverage cap.
  if (rules.maxLeverage !== null && f.leverage !== undefined && f.leverage > rules.maxLeverage) add("leverage_over_cap", "block");

  // 5. Allowlist / unknown contracts.
  if (counterparty && !allowlisted) {
    if (allow.size > 0 && rules.unlistedContract !== "ignore") add("contract_not_allowlisted", rules.unlistedContract);
    else if (approvalish && f.spenderKnown === false && f.approvalForAll !== false) add("unknown_spender", "warn");
  }

  // 6. Off-chain permit signatures.
  if (f.offchainSignature && (f.kind === "permit" || f.kind === "permit2") && rules.permitSignatures !== "ignore" && !allowlisted) {
    add("permit_signature", rules.permitSignatures);
  }

  // 7. Long-lived permits / Permit2 approvals.
  if (rules.maxPermitDays !== null && f.deadline && (f.kind === "permit" || f.kind === "permit2")) {
    if (f.deadline - nowSecs > rules.maxPermitDays * 86400) add("permit_too_long", "warn");
  }
  return hits;
}

export function evaluate(facts: TxFacts[], rules: Rules, nowSecs = Math.floor(Date.now() / 1000)): PolicyResult {
  if (!facts.length) return { verdict: "warn", hits: [{ code: "undecodable", severity: "warn" }] };
  const merged: Hit[] = [];
  for (const f of facts) {
    for (const h of evaluateOne(f, rules, nowSecs)) {
      const i = merged.findIndex((m) => m.code === h.code);
      if (i < 0) merged.push(h);
      else if (RANK[h.severity] > RANK[merged[i].severity]) merged[i] = h;
    }
  }
  const verdict = merged.reduce<Verdict>((v, h) => worst(v, h.severity), "allow");
  merged.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  return { verdict, hits: merged };
}
