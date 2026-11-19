/** Plain-English verdicts for humans (and X demo clips). */
import type { Hit, PolicyResult, TxFacts } from "./types.js";
import { CHAINS, shortAddr } from "./registry.js";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtNum = (n: number) => (n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(Math.round(n * 10000) / 10000));

function who(f: TxFacts, which: "spender" | "target" | "recipient" = "spender"): string {
  const a = which === "spender" ? f.spender ?? f.target : which === "recipient" ? f.recipient : f.target;
  const label = which === "spender" ? f.spenderLabel ?? (f.spender ? undefined : f.targetLabel) : f.targetLabel;
  if (label) return `${label} (${shortAddr(a)})`;
  if (!a) return "an unknown address";
  return `an unknown contract ${shortAddr(a)}`;
}

function amountStr(f: TxFacts): string {
  const sym = f.tokenSymbol ?? "tokens";
  if (f.unlimited) return `UNLIMITED ${sym}`;
  if (f.amount !== undefined) return `${fmtNum(f.amount)} ${sym}${f.amountUsd !== undefined && !/USD|DAI/.test(sym) ? ` (≈$${fmtNum(f.amountUsd)})` : ""}`;
  if (f.amountRaw !== undefined) return `${f.amountRaw} base units of ${sym}`;
  return sym;
}

/** One line describing what the tx does, regardless of verdict. */
export function describe(f: TxFacts): string {
  const chain = f.chainId && CHAINS[f.chainId] ? ` on ${CHAINS[f.chainId].name}` : "";
  switch (f.kind) {
    case "approve":
    case "increaseAllowance":
      return `Lets ${who(f)} spend ${amountStr(f)} from your wallet${chain}.`;
    case "permit":
      return `${f.offchainSignature ? "Gasless signature that lets" : "Permit lets"} ${who(f)} spend ${amountStr(f)}${chain}${f.offchainSignature ? " — no transaction shows up until they use it" : ""}.`;
    case "permit2":
      return `Permit2 ${f.offchainSignature ? "signature" : "approval"} letting ${who(f)} move ${amountStr(f)}${chain}.`;
    case "setApprovalForAll":
      return f.approvalForAll ? `Gives ${who(f)} control of ALL your tokens in collection ${shortAddr(f.token)}${chain} (NFTs / outcome shares).` : `Revokes ${who(f)}'s operator access${chain}.`;
    case "transfer":
    case "transferFrom":
      return `Sends ${amountStr(f)} to ${f.recipient ? shortAddr(f.recipient) : "someone"}${chain}.`;
    case "native_transfer":
      return `Sends ${amountStr(f)} to ${who(f, "recipient")}${chain}.`;
    case "perp_open":
      return `Opens a ${f.protocol ?? "perp"} position${f.sizeUsd ? ` of ≈$${fmtNum(f.sizeUsd)}` : ""}${f.leverage ? ` at ${f.leverage}x leverage` : ""}.`;
    case "perp_leverage":
      return `Sets ${f.protocol ?? "perp"} leverage to ${f.leverage}x.`;
    case "contract_call":
      return `Calls ${who(f, "target")}${f.method ? ` (${f.method})` : ""}${f.amountUsd !== undefined ? `, moving ≈$${fmtNum(f.amountUsd)}` : ""}${chain}.`;
    default:
      return `Couldn't decode this${f.target ? ` call to ${shortAddr(f.target)}` : ""}. Blind-signing unknown data is how most drains happen.`;
  }
}

function hitLine(h: Hit, f: TxFacts | undefined): string {
  const x = f ?? ({ kind: "unknown" } as TxFacts);
  switch (h.code) {
    case "unlimited_approval":
      return `It asks for UNLIMITED ${x.tokenSymbol ?? "token"} access. ${cap(who(x))} could drain every ${x.tokenSymbol ?? "token"} you hold — today or months from now.`;
    case "approval_for_all":
      return `It hands over ALL your tokens in this collection, not just one.`;
    case "spend_over_cap":
      return x.unlimited ? `No cap at all — way past the spend limit you set.` : `It moves more than the spend limit you set.`;
    case "spend_unpriced":
      return `Couldn't price ${x.tokenSymbol ?? "this token"} in USD, so your spend limit couldn't be checked.`;
    case "leverage_over_cap":
      return `${x.leverage}x leverage is above the max leverage you set.`;
    case "contract_not_allowlisted":
      return `${cap(who(x))} isn't on your trusted-contracts list.`;
    case "unknown_spender":
      return `SignGuard doesn't recognise ${shortAddr(x.spender ?? x.target)} as a known protocol.`;
    case "permit_signature":
      return `It's an off-chain permit signature — a favourite drainer trick because nothing shows on-chain until your funds move.`;
    case "permit_too_long":
      return `The permission lasts longer than the max you allow.`;
    case "undecodable":
      return `SignGuard couldn't fully decode it.`;
  }
}

const CODE_FACT: Partial<Record<Hit["code"], (f: TxFacts) => boolean>> = {
  unlimited_approval: (f) => !!f.unlimited,
  approval_for_all: (f) => !!f.approvalForAll,
  spend_over_cap: (f) => !!f.unlimited || f.amountUsd !== undefined,
  leverage_over_cap: (f) => f.leverage !== undefined,
  permit_signature: (f) => !!f.offchainSignature,
  unknown_spender: (f) => f.spenderKnown === false,
};

export interface Explanation {
  headline: string;
  emoji: string;
  what: string[];
  why: string[];
}

export function explain(facts: TxFacts[], result: PolicyResult): Explanation {
  const what = facts.length ? facts.map(describe) : ["Nothing to decode."];
  const why = result.hits.map((h) => cap(hitLine(h, facts.find((f) => CODE_FACT[h.code]?.(f)) ?? facts[0])));
  const top = result.hits[0];
  const f0 = facts.find((f) => top && CODE_FACT[top.code]?.(f)) ?? facts[0];
  let headline: string;
  if (result.verdict === "block") {
    if (top?.code === "unlimited_approval") headline = `Don't sign. This wants unlimited ${f0?.tokenSymbol ?? "token"} spend.`;
    else if (top?.code === "approval_for_all") headline = "Don't sign. This hands over everything in the collection.";
    else if (top?.code === "leverage_over_cap") headline = `Don't sign. ${f0?.leverage}x breaks your leverage rule.`;
    else if (top?.code === "spend_over_cap") headline = "Don't sign. This is over your spend limit.";
    else headline = "Don't sign. This breaks your rules.";
  } else if (result.verdict === "warn") {
    headline = "Careful — double-check before you sign.";
  } else {
    headline = "Looks OK under your rules.";
  }
  return { headline, emoji: result.verdict === "block" ? "🛑" : result.verdict === "warn" ? "⚠️" : "✅", what, why };
}
