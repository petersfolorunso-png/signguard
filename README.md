# 🛡️ SignGuard — don't sign blind

**A pre-sign copilot for perp, DEX and prediction-market wallets.** Paste any
transaction or signature request; SignGuard decodes it and checks it against
**your private rules** — sealed in your own [Terminal 3](https://docs.terminal3.io)
(T3N) vault — then tells you in plain English whether to sign:

> 🛑 **Don't sign. This wants unlimited USDC spend.**
> It asks for UNLIMITED USDC access. An unknown contract 0x3C1E…0e91 could drain every USDC you hold — today or months from now.

No wallet connection, no seed phrase, no deposit. One tap on **“Try a scary tx”** and you've used it.

Built for the Terminal 3 Build+Scale Agent Micro Grant.

---

## What it catches

| Input you can paste | What it decodes |
| --- | --- |
| Raw calldata (`0x095ea7b3…`), optionally with chain + contract | ERC-20 `approve`, `increaseAllowance`, `transfer`, `transferFrom`, on-chain `permit`, `setApprovalForAll`, Permit2 `approve`, `multicall` (recursed), GMX v1 `createIncreasePosition(ETH)` with leverage |
| EVM tx JSON / `eth_sendTransaction` params | Same, with chain from `chainId` |
| `eth_signTypedData_v4` payloads | EIP-2612 `Permit` (incl. DAI-style), Permit2 `PermitSingle` / `PermitBatch` / `PermitTransferFrom` variants, Polymarket CTF `Order` (BUY spend) |
| Hyperliquid actions | `updateLeverage`, `order` (size) |
| A tx hash | Fetched read-only from Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain public RPCs |
| The text your wallet popup shows | Best-effort: “Unlimited USDC”, spender, amounts, “40x” leverage |

Known tokens (USDC/USDT/DAI/WETH across chains) and protocols (Uniswap, Permit2,
1inch, 0x, Aave, Polymarket, Hyperliquid bridge, GMX) are labelled from a public
registry in `src/core/registry.ts` — labels only; trust decisions come from *your* allowlist.

## Your private rules

| Rule | Default |
| --- | --- |
| Block unlimited approvals / permits | on |
| Block `setApprovalForAll` | on |
| Max spend per tx (USD) | $1,000 |
| Max leverage | 10x |
| Trusted contracts (allowlist) + what to do with unlisted ones | empty, warn |
| Off-chain permit signatures | warn |
| Max permit lifetime | 30 days |

The policy returns only **allow / warn / block** plus reason codes
(e.g. `leverage_over_cap`) — never your thresholds or allowlist.

## How Terminal 3 is used

```
 browser ──paste──▶ SignGuard server ──decode──▶ TxFacts (no secrets)
                         │
   user's did:t3n  ◀─────┤ 1. first visit: a fresh identity key signs in to T3N → did:t3n
   (own T3N vault)       │ 2. "Seal rules": self call set_rules → private map z:<tid>:rules
                         │    + member delegation: user grants the SignGuard agent `check` only
                         │ 3. every check: agent invoke(check, pii_did = user DID)
                         ▼
          TEE contract z:<tid>:signguard (Rust → WASM, tenant-base world, no HTTP)
          reads the caller's rules, returns {verdict, codes}; labels the call
          {sg_op: check, verdict, hits} in T3N's tamper-evident activity log
```

* **`did:t3n` per user** — every visitor gets their own T3N identity on first visit.
* **Private vault** — rules are stored by the user's own session in a private map that
  only the SignGuard contract can read (`readers/writers: only [contract_id]`).
* **TEE policy contract** — `contracts/signguard-policy` (Rust, WASM component). It
  imports only `tenant-context`, `logging` and `kv-store`, so rules cannot leave the
  enclave. Rules are keyed by `calling_user_did()`, never by a DID in the input.
* **Scoped delegation** — the user grants the agent exactly one function (`check`);
  `set-rules` / `forget` refuse delegated calls.
* **Audit log + traction metric** — each check is an agent call *on behalf of* the
  user DID, paid in T3 credits and recorded in the org activity log
  (`actor = agent`, `on_behalf_of = user`). The DID export merges that log with
  local stats for the submission form.

The policy logic exists twice — `src/core/rules.ts` (mock mode, tests) and
`contracts/signguard-policy/src/logic.rs` (the TEE) — and **both are tested against the
same vectors** in `test-vectors/policy.json`.

## Privacy model

* SignGuard never asks for, sees or stores a seed phrase or wallet private key, and never signs or broadcasts anything.
* Pasted transactions are decoded in memory and not stored.
* Rules: in real mode the server passes them through to the user's T3N vault and keeps no copy. The browser keeps a device-only copy so the editor can show them.
* Stats store only DIDs (pseudonymous), verdicts and tx kinds — no tx data, no IPs. The public dashboard shows truncated DIDs; the full list is behind `SIGNGUARD_ADMIN_TOKEN`.
* **v1 limitation (honest):** to keep the “1-minute, no wallet” try-out, each browser's T3N *identity* key is a throwaway key generated and held server-side, encrypted at rest (AES-256-GCM). It controls no funds, and the contract exposes no “read rules” function, but the operator could in principle act as that identity. v2 moves the key into the browser (or SIWE with the user's own wallet).

## Run it

```bash
npm install
npm test               # 54 TS tests (decoder, policy vectors, API)
npm run test:contract  # Rust TEE logic against the same vectors
npm run dev            # API :8787 + web :5173 (mock T3N)
# or production-style:
npm run build && npm start   # serves dist/ + API on :8787
```

With no T3N credentials the server runs in **mock mode**: DIDs (`did:t3n:mock…`),
the vault and a hash-chained activity log are simulated locally in `data/`, and the
UI shows a “Mock T3N” pill. Nothing touches the network except optional price and
tx-hash lookups.

### Switching to real T3N (testnet)

1. Claim a key at https://www.terminal3.io/claim-page (shown once). Save it:
   ```bash
   mkdir -p ~/.secrets/terminal3 && chmod 700 ~/.secrets/terminal3
   printf 'T3N_ENV=testnet\nT3N_API_KEY=%s\n' '<paste>' > ~/.secrets/terminal3/t3.env
   chmod 600 ~/.secrets/terminal3/t3.env
   ```
2. `npm run t3n:smoke` — prints your developer DID and credit balance.
3. `npm run build:contract` (needs `rustup target add wasm32-wasip2`).
4. `npm run t3n:setup -- --org --agent --fund 50 --register` — creates the org and the
   SignGuard agent, funds it, registers `z:<tid>:signguard` and its private `rules` map.
   Secrets are written straight to the env file and never printed.
5. `npm start` — the log shows `mode=real`; the UI pill turns “T3N testnet”.
6. `npm run export:dids` — CSV/JSON of every DID for the DoraHacks form.

### API

| Method | Path | |
| --- | --- | --- |
| POST | `/api/session` | `{handle?}` → `{handle, did, created, hasRules, mode}` |
| PUT | `/api/rules` | `{handle, rules}` → seals rules in the user's vault |
| POST | `/api/check` | `{handle, input, chainId?, to?}` → facts, verdict, plain-English explanation |
| GET | `/api/stats` | public dashboard numbers |
| GET | `/api/admin/dids[?format=csv]` | `x-admin-token` required |
| GET | `/api/status` | adapter mode / readiness |

## Layout

```
src/core/      decoder, rule engine, explanations, samples, registry (pure TS)
src/server/    Express API, T3N adapter (mock + real), usage stats, chain lookups
src/web/       React UI (Vite)
contracts/signguard-policy/   Rust TEE contract (WASM component for T3N)
scripts/       t3n-smoke, t3n-setup, export-dids
test/, test-vectors/          vitest suites + shared policy vectors
```

## Disclaimer

SignGuard is a safety aid, not a guarantee and not financial advice. A “looks OK”
only means the transaction passed *your* rules. When in doubt, don't sign.

License: MIT. `contracts/signguard-policy/wit/deps` is vendored from
Terminal-3/agent-vault-starter (Apache-2.0).
