/**
 * Turns whatever a user pastes (raw calldata, an EVM tx JSON, an
 * eth_signTypedData_v4 payload, a Hyperliquid action, a tx hash, or the
 * approval text their wallet shows) into normalized `TxFacts`.
 *
 * Pure and synchronous. Tx-hash lookup lives on the server (it needs RPC).
 */
import { Interface, getAddress, isAddress, formatUnits } from "ethers";
import type { TxFacts } from "./types.js";
import { CHAINS, lookupContract, lookupToken, tokenBySymbol } from "./registry.js";

export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_UINT160 = (1n << 160n) - 1n;
/** Anything at or above 2^128 base units is "unlimited" in practice. */
const UNLIMITED_RAW = 1n << 128n;
/** For tokens we know the decimals of, 1 trillion+ tokens is unlimited too. */
const UNLIMITED_HUMAN = 1e12;

export interface DecodeOptions {
  chainId?: number;
  /** tx.to when the user pastes bare calldata. */
  to?: string;
  /** Optional live prices by symbol, e.g. { ETH: 3200 }. Stablecoins are pegged. */
  prices?: Record<string, number>;
}

export interface EvmTx {
  to?: string;
  data?: string;
  input?: string;
  value?: string | number;
  chainId?: string | number;
  from?: string;
}

export type InputSource = "calldata" | "tx" | "typed_data" | "hyperliquid" | "text" | "hash" | "empty";

export interface DecodeResult {
  source: InputSource;
  chainId?: number;
  facts: TxFacts[];
  /** Set when source === "hash": the server must fetch the tx first. */
  hash?: string;
}

const ERC20 = new Interface([
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 addedValue)",
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function setApprovalForAll(address operator, bool approved)",
]);
const PERMIT2 = new Interface(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
const MULTICALL = new Interface([
  "function multicall(bytes[] data)",
  "function multicall(uint256 deadline, bytes[] data)",
]);
const GMX_V1 = new Interface([
  "function createIncreasePosition(address[] _path, address _indexToken, uint256 _amountIn, uint256 _minOut, uint256 _sizeDelta, bool _isLong, uint256 _acceptablePrice, uint256 _executionFee, bytes32 _referralCode, address _callbackTarget)",
  "function createIncreasePositionETH(address[] _path, address _indexToken, uint256 _minOut, uint256 _sizeDelta, bool _isLong, uint256 _acceptablePrice, uint256 _executionFee, bytes32 _referralCode, address _callbackTarget)",
]);

const SEL = {
  approve: ERC20.getFunction("approve")!.selector,
  increaseAllowance: ERC20.getFunction("increaseAllowance")!.selector,
  transfer: ERC20.getFunction("transfer")!.selector,
  transferFrom: ERC20.getFunction("transferFrom")!.selector,
  permit: ERC20.getFunction("permit")!.selector,
  setApprovalForAll: ERC20.getFunction("setApprovalForAll")!.selector,
  permit2Approve: PERMIT2.getFunction("approve")!.selector,
  multicall: MULTICALL.getFunction("multicall(bytes[])")!.selector,
  multicallDeadline: MULTICALL.getFunction("multicall(uint256,bytes[])")!.selector,
  gmxIncrease: GMX_V1.getFunction("createIncreasePosition")!.selector,
  gmxIncreaseEth: GMX_V1.getFunction("createIncreasePositionETH")!.selector,
};
export const SELECTORS = SEL;

// ---------------------------------------------------------------- helpers

function toChainId(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "string" && v.startsWith("0x") ? parseInt(v, 16) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function toBig(v: unknown): bigint | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(Math.trunc(v));
    return BigInt(String(v).trim());
  } catch {
    return undefined;
  }
}

function addr(a: unknown): string | undefined {
  if (typeof a !== "string" || !isAddress(a)) return undefined;
  return getAddress(a.toLowerCase());
}

function priceFor(symbol: string | undefined, opts: DecodeOptions, pegged?: number): number | undefined {
  if (pegged !== undefined) return pegged;
  if (!symbol) return undefined;
  const s = symbol.toUpperCase().replace(/^W(ETH|BNB)$/, "$1");
  return opts.prices?.[s] ?? opts.prices?.[symbol.toUpperCase()];
}

/** Fill in token/label/amount/usd/unlimited from the registry. */
export function enrich(f: TxFacts, opts: DecodeOptions): TxFacts {
  const chainId = f.chainId;
  if (f.token) {
    const t = lookupToken(chainId, f.token);
    if (t) {
      f.tokenSymbol ??= t.symbol;
      f.tokenDecimals ??= t.decimals;
    }
  }
  if (f.target) {
    const c = lookupContract(chainId, f.target);
    if (c) {
      f.targetLabel ??= c.label;
      f.protocol ??= c.protocol;
    }
    f.targetKnown = !!c || !!lookupToken(chainId, f.target);
  }
  if (f.spender) {
    const c = lookupContract(chainId, f.spender);
    f.spenderKnown = !!c;
    if (c) {
      f.spenderLabel ??= c.label;
      f.protocol ??= c.protocol;
    }
  }
  if (f.amountRaw !== undefined) {
    const raw = BigInt(f.amountRaw);
    let unlimited = raw >= UNLIMITED_RAW;
    if (f.tokenDecimals !== undefined) {
      f.amount = Number(formatUnits(raw, f.tokenDecimals));
      if (f.amount >= UNLIMITED_HUMAN) unlimited = true;
      const t = f.token ? lookupToken(chainId, f.token) : undefined;
      const p = priceFor(f.tokenSymbol, opts, t?.usd);
      if (p !== undefined && !unlimited) f.amountUsd = round2(f.amount * p);
    }
    f.unlimited = unlimited;
  }
  return f;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- EVM calldata

export function decodeCalldata(data: string, ctx: { to?: string; chainId?: number; value?: bigint }, opts: DecodeOptions, depth = 0): TxFacts[] {
  const to = addr(ctx.to);
  const chainId = ctx.chainId;
  const clean = data.trim().toLowerCase();
  const sel = clean.slice(0, 10);
  const base: TxFacts = { kind: "unknown", chainId, target: to };

  if (clean === "0x" || clean === "") {
    if (ctx.value && ctx.value > 0n) {
      const native = chainId ? CHAINS[chainId]?.native ?? "ETH" : "ETH";
      const amount = Number(formatUnits(ctx.value, 18));
      const p = opts.prices?.[native];
      return [{ ...base, kind: "native_transfer" as const, recipient: to, target: to, tokenSymbol: native, tokenDecimals: 18, amountRaw: ctx.value.toString(), amount, amountUsd: p !== undefined ? round2(amount * p) : undefined, method: "send", spender: undefined }].map((f) => enrich(f, opts));
    }
    return [enrich({ ...base, kind: "unknown", notes: ["Empty transaction."] }, opts)];
  }

  try {
    switch (sel) {
      case SEL.approve: {
        const [spender, amount] = ERC20.decodeFunctionData("approve", clean);
        return [enrich({ ...base, kind: "approve", method: "approve(address,uint256)", token: to, spender: addr(spender), amountRaw: amount.toString() }, opts)];
      }
      case SEL.increaseAllowance: {
        const [spender, amount] = ERC20.decodeFunctionData("increaseAllowance", clean);
        return [enrich({ ...base, kind: "increaseAllowance", method: "increaseAllowance(address,uint256)", token: to, spender: addr(spender), amountRaw: amount.toString() }, opts)];
      }
      case SEL.transfer: {
        const [recipient, amount] = ERC20.decodeFunctionData("transfer", clean);
        return [enrich({ ...base, kind: "transfer", method: "transfer(address,uint256)", token: to, recipient: addr(recipient), amountRaw: amount.toString() }, opts)];
      }
      case SEL.transferFrom: {
        const [from, recipient, amount] = ERC20.decodeFunctionData("transferFrom", clean);
        return [enrich({ ...base, kind: "transferFrom", method: "transferFrom(address,address,uint256)", token: to, recipient: addr(recipient), amountRaw: amount.toString(), notes: [`Moves tokens out of ${addr(from)}.`] }, opts)];
      }
      case SEL.permit: {
        const [, spender, value, deadline] = ERC20.decodeFunctionData("permit", clean);
        return [enrich({ ...base, kind: "permit", method: "permit(...)", token: to, spender: addr(spender), amountRaw: value.toString(), deadline: Number(deadline) }, opts)];
      }
      case SEL.setApprovalForAll: {
        const [operator, approved] = ERC20.decodeFunctionData("setApprovalForAll", clean);
        return [enrich({ ...base, kind: "setApprovalForAll", method: "setApprovalForAll(address,bool)", token: to, spender: addr(operator), approvalForAll: Boolean(approved), notes: approved ? [] : ["This REVOKES an operator — that is safe."] }, opts)];
      }
      case SEL.permit2Approve: {
        const [token, spender, amount, expiration] = PERMIT2.decodeFunctionData("approve", clean);
        const f = enrich({ ...base, kind: "permit2", method: "Permit2.approve", token: addr(token), spender: addr(spender), amountRaw: amount.toString(), deadline: Number(expiration) }, opts);
        if (BigInt(amount) >= MAX_UINT160) f.unlimited = true;
        return [f];
      }
      case SEL.multicall:
      case SEL.multicallDeadline: {
        if (depth > 2) break;
        const decoded = sel === SEL.multicall ? MULTICALL.decodeFunctionData("multicall(bytes[])", clean) : MULTICALL.decodeFunctionData("multicall(uint256,bytes[])", clean);
        const calls: string[] = sel === SEL.multicall ? decoded[0] : decoded[1];
        const inner = calls.flatMap((c) => decodeCalldata(c, ctx, opts, depth + 1));
        return inner.length ? inner : [enrich({ ...base, kind: "contract_call", method: "multicall" }, opts)];
      }
      case SEL.gmxIncrease:
      case SEL.gmxIncreaseEth: {
        const isEth = sel === SEL.gmxIncreaseEth;
        const d = GMX_V1.decodeFunctionData(isEth ? "createIncreasePositionETH" : "createIncreasePosition", clean);
        const path: string[] = d[0];
        const sizeUsd = Number(formatUnits(isEth ? d[3] : d[4], 30));
        const isLong: boolean = isEth ? d[4] : d[5];
        let collateralUsd: number | undefined;
        const collateralToken = addr(path[0]);
        if (isEth) {
          const fee = BigInt(d[6]);
          const eth = Number(formatUnits((ctx.value ?? 0n) - fee, 18));
          const p = opts.prices?.ETH;
          if (p !== undefined) collateralUsd = eth * p;
        } else {
          const t = lookupToken(chainId, collateralToken);
          if (t) {
            const p = priceFor(t.symbol, opts, t.usd);
            if (p !== undefined) collateralUsd = Number(formatUnits(d[2], t.decimals)) * p;
          }
        }
        const leverage = collateralUsd && collateralUsd > 0 ? round2(sizeUsd / collateralUsd) : undefined;
        return [enrich({ ...base, kind: "perp_open", method: isEth ? "GMX createIncreasePositionETH" : "GMX createIncreasePosition", protocol: "GMX", sizeUsd: round2(sizeUsd), leverage, amountUsd: collateralUsd !== undefined ? round2(collateralUsd) : undefined, notes: [`${isLong ? "Long" : "Short"} position, size ≈ $${round2(sizeUsd).toLocaleString("en-US")}.`] }, opts)];
      }
    }
  } catch {
    return [enrich({ ...base, kind: "unknown", method: sel, notes: ["Calldata matched a known function but could not be decoded — treat as suspicious."] }, opts)];
  }

  const f = enrich({ ...base, kind: to && lookupContract(chainId, to) ? "contract_call" : "unknown", method: sel }, opts);
  if (ctx.value && ctx.value > 0n) {
    f.amountRaw = ctx.value.toString();
    f.tokenDecimals = 18;
    f.amount = Number(formatUnits(ctx.value, 18));
    f.tokenSymbol = chainId ? CHAINS[chainId]?.native ?? "ETH" : "ETH";
    const p = opts.prices?.[f.tokenSymbol];
    if (p !== undefined) f.amountUsd = round2(f.amount * p);
  }
  return [f];
}

export function decodeEvmTx(tx: EvmTx, opts: DecodeOptions): TxFacts[] {
  const chainId = toChainId(tx.chainId) ?? opts.chainId;
  const data = (tx.data ?? tx.input ?? "0x") as string;
  return decodeCalldata(data, { to: tx.to ?? opts.to, chainId, value: toBig(tx.value) }, opts);
}

// ---------------------------------------------------------------- EIP-712

interface TypedData {
  domain?: { name?: string; chainId?: number | string; verifyingContract?: string };
  primaryType?: string;
  message?: Record<string, any>;
  types?: Record<string, unknown>;
}

export function decodeTypedData(td: TypedData, opts: DecodeOptions): TxFacts[] {
  const chainId = toChainId(td.domain?.chainId) ?? opts.chainId;
  const vc = addr(td.domain?.verifyingContract);
  const m = td.message ?? {};
  const base: TxFacts = { kind: "unknown", chainId, target: vc, offchainSignature: true, method: `signTypedData:${td.primaryType}` };

  switch (td.primaryType) {
    case "Permit": // EIP-2612 (+ DAI-style allowed:bool)
      if ("allowed" in m) {
        return [enrich({ ...base, kind: "permit", token: vc, spender: addr(m.spender), amountRaw: m.allowed ? MAX_UINT256.toString() : "0", deadline: Number(m.expiry ?? 0) || undefined }, opts)];
      }
      return [enrich({ ...base, kind: "permit", token: vc, spender: addr(m.spender), amountRaw: String(toBig(m.value) ?? 0n), deadline: Number(m.deadline ?? 0) || undefined }, opts)];
    case "PermitSingle":
    case "PermitBatch": {
      const details: any[] = Array.isArray(m.details) ? m.details : [m.details];
      return details.filter(Boolean).map((d) => {
        const amt = toBig(d.amount) ?? 0n;
        const f = enrich({ ...base, kind: "permit2", token: addr(d.token), spender: addr(m.spender), amountRaw: amt.toString(), deadline: Number(d.expiration ?? m.sigDeadline ?? 0) || undefined }, opts);
        if (amt >= MAX_UINT160) f.unlimited = true;
        return f;
      });
    }
    case "PermitTransferFrom":
    case "PermitBatchTransferFrom":
    case "PermitWitnessTransferFrom":
    case "PermitBatchWitnessTransferFrom": {
      const permitted: any[] = Array.isArray(m.permitted) ? m.permitted : [m.permitted];
      return permitted.filter(Boolean).map((p) =>
        enrich({ ...base, kind: "permit2", token: addr(p.token), spender: addr(m.spender), amountRaw: String(toBig(p.amount) ?? 0n), deadline: Number(m.deadline ?? 0) || undefined, notes: ["Signature transfer: the spender can pull these tokens once, right away."] }, opts),
      );
    }
    case "Order": {
      if (/polymarket/i.test(td.domain?.name ?? "") || lookupContract(chainId, vc)?.protocol === "Polymarket") {
        const side = Number(m.side ?? 0); // 0 = BUY (spend USDC), 1 = SELL (spend outcome tokens)
        const maker = toBig(m.makerAmount) ?? 0n;
        if (side === 0) {
          const usd = Number(formatUnits(maker, 6));
          return [enrich({ ...base, kind: "contract_call", protocol: "Polymarket", amountUsd: round2(usd), tokenSymbol: "USDC", amount: usd, notes: [`Polymarket BUY order spending up to $${round2(usd)}.`] }, opts)];
        }
        return [enrich({ ...base, kind: "contract_call", protocol: "Polymarket", notes: ["Polymarket SELL order."] }, opts)];
      }
      break;
    }
  }
  return [enrich({ ...base, notes: [`Unrecognised signature request "${td.primaryType ?? "?"}". Only sign typed data you understand.`] }, opts)];
}

// ---------------------------------------------------------------- Hyperliquid

export function decodeHyperliquid(action: any): TxFacts[] {
  const a = action?.action ?? action;
  if (a?.type === "updateLeverage") {
    return [{ kind: "perp_leverage", protocol: "Hyperliquid", leverage: Number(a.leverage), method: "Hyperliquid updateLeverage", offchainSignature: true, notes: [`Asset #${a.asset}, ${a.isCross ? "cross" : "isolated"} margin.`] }];
  }
  if (a?.type === "order" && Array.isArray(a.orders)) {
    return a.orders.map((o: any) => {
      const px = Number(o.p ?? o.limit_px ?? 0);
      const sz = Number(o.s ?? o.sz ?? 0);
      const lev = action?.leverage ?? a.leverage;
      return { kind: "perp_open" as const, protocol: "Hyperliquid", method: "Hyperliquid order", offchainSignature: true, sizeUsd: round2(px * sz), leverage: lev !== undefined ? Number(lev) : undefined, notes: [`${(o.b ?? o.is_buy) ? "Buy/long" : "Sell/short"} ${sz} @ ${px}.`] };
    });
  }
  return [{ kind: "unknown", protocol: "Hyperliquid", offchainSignature: true, notes: [`Unrecognised Hyperliquid action "${a?.type}".`] }];
}

// ---------------------------------------------------------------- free text

/** Best-effort parse of what a wallet popup shows, e.g. "Spending cap: Unlimited USDC, spender 0x…". */
export function decodeText(text: string, opts: DecodeOptions): TxFacts[] {
  const t = text.replace(/\s+/g, " ");
  const addrs = [...t.matchAll(/0x[a-fA-F0-9]{40}/g)].map((m) => addr(m[0])!).filter(Boolean);
  const spenderMatch = t.match(/(?:spender|operator|to|contract|site|interacting with)[^0-9a-zA-Z]{0,20}(0x[a-fA-F0-9]{40})/i);
  const spender = addr(spenderMatch?.[1]) ?? addrs[0];
  const notes = ["Parsed from pasted wallet text — paste the raw transaction for an exact decode."];
  const symMatch = t.match(/\b(USDC\.e|USDC|USDT|DAI|WETH|ETH|BNB)\b/i);
  const symbol = symMatch?.[1];
  const token = symbol ? tokenBySymbol(symbol) : undefined;

  const lev = t.match(/(\d+(?:\.\d+)?)\s*[x×]\b/i);
  if (lev && /leverage|long|short|perp|position|\d\s*[x×]/i.test(t)) {
    const amt = t.match(/\$\s?(\d[\d,]*(?:\.\d+)?)/);
    return [{ kind: lev && /order|open|long|short|position/i.test(t) ? "perp_open" : "perp_leverage", leverage: Number(lev[1]), sizeUsd: amt ? Number(amt[1].replace(/,/g, "")) : undefined, spender, target: spender, notes }].map((f) => enrich(f as TxFacts, opts));
  }
  if (/set ?approval ?for ?all|access to all|all (of )?your (nfts|tokens|positions)|withdraw all/i.test(t)) {
    return [enrich({ kind: "setApprovalForAll", approvalForAll: true, spender, target: spender, notes, chainId: opts.chainId }, opts)];
  }
  const isPermit = /permit|signature request|sign(ing)? this message/i.test(t);
  const isApprove = /approv|spending cap|allowance|spend your|permission/i.test(t);
  const unlimited = /unlimited|infinite|max(imum)? amount|115792089237316195423570985008687907853269984665640564039457584007913129639935/i.test(t);
  const amtMatch = t.match(/(\d[\d,]*(?:\.\d+)?)\s*(USDC\.e|USDC|USDT|DAI|WETH|ETH|BNB)\b/i);
  const amount = amtMatch ? Number(amtMatch[1].replace(/,/g, "")) : undefined;

  if (isPermit || isApprove) {
    const f: TxFacts = { kind: isPermit ? "permit" : "approve", spender, tokenSymbol: token?.symbol ?? symbol?.toUpperCase(), tokenDecimals: token?.decimals, offchainSignature: isPermit || undefined, unlimited, notes, chainId: opts.chainId };
    if (amount !== undefined && !unlimited) {
      f.amount = amount;
      if (token?.usd !== undefined) f.amountUsd = round2(amount * token.usd);
      else if (symbol && opts.prices?.[symbol.toUpperCase()]) f.amountUsd = round2(amount * opts.prices[symbol.toUpperCase()]);
    }
    const c = lookupContract(opts.chainId, spender);
    f.spenderKnown = !!c;
    if (c) { f.spenderLabel = c.label; f.protocol = c.protocol; }
    return [f];
  }
  if (/send|transfer/i.test(t) && amount !== undefined) {
    const f: TxFacts = { kind: "transfer", recipient: spender, tokenSymbol: symbol?.toUpperCase(), amount, notes, chainId: opts.chainId };
    if (token?.usd !== undefined) f.amountUsd = round2(amount * token.usd);
    return [f];
  }
  return [{ kind: "unknown", notes: ["Couldn't tell what this is. Paste the raw transaction data, the tx JSON, or the signature request."] }];
}

// ---------------------------------------------------------------- entry point

export function decode(raw: string, opts: DecodeOptions = {}): DecodeResult {
  const input = (raw ?? "").trim();
  if (!input) return { source: "empty", facts: [] };

  if (/^0x[0-9a-fA-F]{64}$/.test(input)) return { source: "hash", hash: input.toLowerCase(), facts: [] };
  if (/^0x[0-9a-fA-F]*$/.test(input) && input.length >= 10) {
    const facts = decodeCalldata(input, { to: opts.to, chainId: opts.chainId }, opts);
    return { source: "calldata", chainId: opts.chainId, facts };
  }

  if (input.startsWith("{") || input.startsWith("[")) {
    let j: any;
    try {
      j = JSON.parse(input);
    } catch {
      return { source: "text", facts: decodeText(input, opts) };
    }
    // JSON-RPC wrappers: {method, params} or bare params arrays.
    if (j && j.method && Array.isArray(j.params)) j = j.params;
    if (Array.isArray(j)) {
      // eth_signTypedData_v4: [address, typedData(string|object)]
      const td = j.find((p: any) => (typeof p === "string" && p.trim().startsWith("{")) || (p && typeof p === "object" && p.primaryType));
      if (td) j = typeof td === "string" ? JSON.parse(td) : td;
      else j = j.find((p: any) => p && typeof p === "object") ?? {};
    }
    if (j?.primaryType && j?.message) {
      const facts = decodeTypedData(j, opts);
      return { source: "typed_data", chainId: facts[0]?.chainId, facts };
    }
    if (j?.action?.type || (typeof j?.type === "string" && ["order", "updateLeverage", "withdraw3", "usdSend"].includes(j.type))) {
      return { source: "hyperliquid", facts: decodeHyperliquid(j) };
    }
    if (j && (j.data !== undefined || j.input !== undefined || j.to !== undefined)) {
      if (typeof j.hash === "string" && j.data === undefined && j.input === undefined) return { source: "hash", hash: j.hash, facts: [] };
      const facts = decodeEvmTx(j, opts);
      return { source: "tx", chainId: facts[0]?.chainId, facts };
    }
    return { source: "text", facts: decodeText(input, opts) };
  }
  return { source: "text", facts: decodeText(input, opts) };
}
