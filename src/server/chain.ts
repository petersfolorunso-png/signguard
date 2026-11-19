/** Read-only chain helpers: tx lookup by hash across common chains, and a price feed. */
import { CHAINS } from "../core/registry.js";
import type { EvmTx } from "../core/decoder.js";

async function rpc(url: string, method: string, params: unknown[], timeoutMs = 6000): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error.message ?? "rpc error");
  return j.result;
}

/** Find a tx by hash. Tries the hinted chain first, then all supported chains in parallel. */
export async function lookupTx(hash: string, chainId?: number): Promise<EvmTx | null> {
  const ids = chainId && CHAINS[chainId] ? [chainId] : Object.keys(CHAINS).map(Number);
  const attempts = ids.map(async (id) => {
    const tx = await rpc(CHAINS[id].rpc, "eth_getTransactionByHash", [hash]);
    if (!tx) throw new Error("not found");
    return { to: tx.to ?? undefined, data: tx.input, value: tx.value, chainId: id, from: tx.from } as EvmTx;
  });
  try {
    return await Promise.any(attempts);
  } catch {
    if (chainId) return lookupTx(hash); // hint was wrong — try everything
    return null;
  }
}

let priceCache: { at: number; prices: Record<string, number> } | null = null;

/** ETH/BNB/POL USD prices from CoinGecko's public API, cached 5 min. Failures → {}. */
export async function getPrices(enabled: boolean): Promise<Record<string, number>> {
  if (!enabled) return {};
  if (priceCache && Date.now() - priceCache.at < 5 * 60_000) return priceCache.prices;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,binancecoin,polygon-ecosystem-token&vs_currencies=usd", { signal: AbortSignal.timeout(4000) });
    const j: any = await r.json();
    const prices: Record<string, number> = {};
    if (j.ethereum?.usd) prices.ETH = j.ethereum.usd;
    if (j.binancecoin?.usd) prices.BNB = j.binancecoin.usd;
    if (j["polygon-ecosystem-token"]?.usd) prices.POL = j["polygon-ecosystem-token"].usd;
    priceCache = { at: Date.now(), prices };
    return prices;
  } catch {
    return priceCache?.prices ?? {};
  }
}
