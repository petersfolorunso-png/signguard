/**
 * Public, best-effort registry of well-known tokens and protocol contracts.
 * Used only to *label* things in plain English and to flag "unknown spender".
 * It is not a security allowlist: users keep their own private allowlist in T3N.
 * Addresses are lowercased for lookups. Verify before relying on a label.
 */

export interface TokenInfo {
  symbol: string;
  decimals: number;
  /** USD peg for stablecoins; undefined = unpriced. */
  usd?: number;
}

export interface ContractInfo {
  label: string;
  protocol: string;
}

export const CHAINS: Record<number, { name: string; native: string; rpc: string; explorer: string }> = {
  1: { name: "Ethereum", native: "ETH", rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io" },
  10: { name: "Optimism", native: "ETH", rpc: "https://optimism-rpc.publicnode.com", explorer: "https://optimistic.etherscan.io" },
  56: { name: "BNB Chain", native: "BNB", rpc: "https://bsc-rpc.publicnode.com", explorer: "https://bscscan.com" },
  137: { name: "Polygon", native: "POL", rpc: "https://polygon-bor-rpc.publicnode.com", explorer: "https://polygonscan.com" },
  8453: { name: "Base", native: "ETH", rpc: "https://base-rpc.publicnode.com", explorer: "https://basescan.org" },
  42161: { name: "Arbitrum", native: "ETH", rpc: "https://arbitrum-one-rpc.publicnode.com", explorer: "https://arbiscan.io" },
};

const T = (symbol: string, decimals: number, usd?: number): TokenInfo => ({ symbol, decimals, usd });

/** chainId -> lowercased address -> token */
export const TOKENS: Record<number, Record<string, TokenInfo>> = {
  1: {
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": T("USDC", 6, 1),
    "0xdac17f958d2ee523a2206206994597c13d831ec7": T("USDT", 6, 1),
    "0x6b175474e89094c44da98b954eedeac495271d0f": T("DAI", 18, 1),
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": T("WETH", 18),
  },
  10: {
    "0x0b2c639c533813f4aa9d7837caf62653d097ff85": T("USDC", 6, 1),
    "0x4200000000000000000000000000000000000006": T("WETH", 18),
  },
  56: {
    "0x55d398326f99059ff775485246999027b3197955": T("USDT", 18, 1),
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": T("USDC", 18, 1),
  },
  137: {
    "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": T("USDC.e", 6, 1),
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": T("USDC", 6, 1),
  },
  8453: {
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": T("USDC", 6, 1),
    "0x4200000000000000000000000000000000000006": T("WETH", 18),
  },
  42161: {
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831": T("USDC", 6, 1),
    "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": T("USDC.e", 6, 1),
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": T("USDT", 6, 1),
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": T("WETH", 18),
  },
};

const C = (label: string, protocol: string): ContractInfo => ({ label, protocol });

/** Contracts that are the same on every chain (CREATE2 deployments). */
export const CONTRACTS_ANY_CHAIN: Record<string, ContractInfo> = {
  "0x000000000022d473030f116ddee9f6b43ac78ba3": C("Uniswap Permit2", "Uniswap"),
  "0x1111111254eeb25477b68fb85ed929f73a960582": C("1inch Router v5", "1inch"),
  "0x111111125421ca6dc452d289314280a0f8842a65": C("1inch Router v6", "1inch"),
  "0xdef1c0ded9bec7f1a1670819833240f027b25eff": C("0x Exchange Proxy", "0x"),
};

export const CONTRACTS: Record<number, Record<string, ContractInfo>> = {
  1: {
    "0x7a250d5630b4cf539739df2c5dacb4c659f2488d": C("Uniswap V2 Router", "Uniswap"),
    "0xe592427a0aece92de3edee1f18e0157c05861564": C("Uniswap V3 Router", "Uniswap"),
    "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": C("Uniswap SwapRouter02", "Uniswap"),
    "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": C("Uniswap Universal Router", "Uniswap"),
    "0x66a9893cc07d91d95644aedd05d03f95e1dba8af": C("Uniswap v4 Universal Router", "Uniswap"),
    "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2": C("Aave v3 Pool", "Aave"),
  },
  137: {
    "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e": C("Polymarket CTF Exchange", "Polymarket"),
    "0xc5d563a36ae78145c45a50134d48a1215220f80a": C("Polymarket NegRisk Exchange", "Polymarket"),
    "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296": C("Polymarket NegRisk Adapter", "Polymarket"),
    "0x4d97dcd97ec945f40cf65f87097ace5ea0476045": C("Polymarket Conditional Tokens", "Polymarket"),
  },
  42161: {
    "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7": C("Hyperliquid Bridge", "Hyperliquid"),
    "0xb87a436b93ffe9d75c5cfa7bacfff96430b09868": C("GMX PositionRouter (v1)", "GMX"),
    "0xabbc5f99639c9b6bcb58544ddf04efa6802f4064": C("GMX Router (v1)", "GMX"),
    "0x7452c558d45f8afc8c83dae62c3f8a5be19c71f6": C("GMX Router (v2)", "GMX"),
  },
};

export function lookupToken(chainId: number | undefined, addr: string | undefined): TokenInfo | undefined {
  if (!addr) return undefined;
  const a = addr.toLowerCase();
  if (chainId !== undefined) return TOKENS[chainId]?.[a];
  for (const map of Object.values(TOKENS)) if (map[a]) return map[a];
  return undefined;
}

export function lookupContract(chainId: number | undefined, addr: string | undefined): ContractInfo | undefined {
  if (!addr) return undefined;
  const a = addr.toLowerCase();
  if (CONTRACTS_ANY_CHAIN[a]) return CONTRACTS_ANY_CHAIN[a];
  if (chainId !== undefined) return CONTRACTS[chainId]?.[a];
  for (const map of Object.values(CONTRACTS)) if (map[a]) return map[a];
  return undefined;
}

/** Symbol → token info, for parsing pasted wallet text like "Unlimited USDC". */
export function tokenBySymbol(symbol: string): TokenInfo | undefined {
  const s = symbol.toUpperCase();
  for (const map of Object.values(TOKENS)) for (const t of Object.values(map)) if (t.symbol.toUpperCase() === s) return t;
  return undefined;
}

export function shortAddr(a?: string): string {
  if (!a) return "?";
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
