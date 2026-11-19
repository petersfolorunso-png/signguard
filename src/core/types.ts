/**
 * Shared types. `TxFacts` is the ONLY thing that ever reaches the policy
 * engine (local or the T3N TEE contract). It is derived from a public
 * transaction / signature request and never contains a wallet secret.
 */

export type TxKind =
  | "approve"
  | "increaseAllowance"
  | "permit" // EIP-2612 off-chain signature
  | "permit2" // Uniswap Permit2 (on-chain approve or off-chain PermitSingle/Batch)
  | "setApprovalForAll"
  | "transfer"
  | "transferFrom"
  | "native_transfer"
  | "perp_open" // opening / increasing a leveraged position
  | "perp_leverage" // changing leverage setting (e.g. Hyperliquid updateLeverage)
  | "contract_call" // known contract, generic call
  | "unknown";

export interface TxFacts {
  kind: TxKind;
  /** EVM chain id if known. */
  chainId?: number;
  /** The contract the wallet is talking to (tx.to / verifyingContract). */
  target?: string;
  /** Who gets the power to move funds (approve spender, permit spender, operator). */
  spender?: string;
  /** Recipient for transfers. */
  recipient?: string;
  /** Token contract involved. */
  token?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  /** Raw integer amount as a decimal string. */
  amountRaw?: string;
  /** Human amount (amountRaw / 10^decimals) if decimals known. */
  amount?: number;
  /** USD value if we can price it (stablecoins / native with known price). */
  amountUsd?: number;
  /** Amount is effectively unlimited (>= 2^255 or MaxUint160 for Permit2 etc.). */
  unlimited?: boolean;
  /** setApprovalForAll(true): operator can move every NFT / outcome token. */
  approvalForAll?: boolean;
  /** Leverage requested (perp_open / perp_leverage). */
  leverage?: number;
  /** Notional position size in USD for perp_open. */
  sizeUsd?: number;
  /** Signature deadline / expiration (unix seconds). */
  deadline?: number;
  /** True when this is an off-chain signature (permit, typed data) rather than a tx. */
  offchainSignature?: boolean;
  /** Labels for addresses we recognise (e.g. "Uniswap Permit2"). */
  targetLabel?: string;
  spenderLabel?: string;
  /** Whether spender/target is in SignGuard's public registry of known protocols. */
  spenderKnown?: boolean;
  targetKnown?: boolean;
  /** Protocol family if recognised. */
  protocol?: string;
  /** Function name decoded, e.g. "approve(address,uint256)". */
  method?: string;
  /** Decoder notes for the UI (never sent to the policy). */
  notes?: string[];
}

export type Verdict = "allow" | "warn" | "block";

/** User's private rules. Stored in the T3N vault, never in SignGuard's DB. */
export interface Rules {
  /** Block approvals/permits with an unlimited amount. */
  blockUnlimitedApprovals: boolean;
  /** Block setApprovalForAll(true) to contracts not on the allowlist. */
  blockApprovalForAll: boolean;
  /** Max USD that a single approval / transfer / permit may move. null = off. */
  maxSpendUsd: number | null;
  /** Max leverage for perp positions. null = off. */
  maxLeverage: number | null;
  /** Contracts the user trusts (lowercased 0x addresses). */
  allowlist: string[];
  /** What to do when the spender/target is not on the allowlist. */
  unlistedContract: "ignore" | "warn" | "block";
  /** Off-chain permit signatures (a favourite drainer trick). */
  permitSignatures: "ignore" | "warn" | "block";
  /** Max permit/approval lifetime in days. null = off. */
  maxPermitDays: number | null;
}

export type ReasonCode =
  | "unlimited_approval"
  | "approval_for_all"
  | "spend_over_cap"
  | "spend_unpriced"
  | "leverage_over_cap"
  | "contract_not_allowlisted"
  | "unknown_spender"
  | "permit_signature"
  | "permit_too_long"
  | "undecodable";

export interface Hit {
  code: ReasonCode;
  severity: Exclude<Verdict, "allow">;
}

/** What the policy (TEE) returns: verdict + reason codes, never the rules. */
export interface PolicyResult {
  verdict: Verdict;
  hits: Hit[];
}
