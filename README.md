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
* **Credits (default `T3N_USER_MODE=self`)** — a brand-new DID has **0 credits**
  (verified on testnet). So when a visitor first arrives, the org admin adds their
  DID to the SignGuard organisation (`addOrganisationMember`) and sponsors a few
  credits (`fundAgent`, which accepts human org members). The user's own session
  then calls `set-rules` and `check` as self calls (no grant needed), so **each
  user DID burns its own credits** — exactly what the grant measures. Caps:
  `SIGNGUARD_USER_CREDITS` (100), `SIGNGUARD_USER_CREDIT_CAP` (300 per user),
  `SIGNGUARD_DAILY_CREDIT_BUDGET` (1500/day). On `InsufficientCredit` the adapter
  tops up once within the caps and retries. Users who never customise rules skip
  `set-rules` entirely (the TEE falls back to defaults).
  **Open issue:** T3N only lets an org add *registered* users (email-verified via
  `user-upsert`), so wallet-only burner DIDs can't be sponsored yet — see
  "Measured costs & onboarding" below.
* **Delegated mode (optional, `T3N_USER_MODE=delegated`)** — the user grants an
  org-owned SignGuard agent exactly one function (`check`) and the agent pays.
  Not the default: the grant is a `tee:user` call that testnet charged ~30 credits
  and refused for a 0-credit DID with "required=10,000 credits available".
* **Audit log** — every check lands in the org activity log (labels
  `sg_op=check, verdict, hits`); as org admin, the export reads all members' rows
  and merges them with local stats for the submission form.

The policy logic exists twice — `src/core/rules.ts` (mock mode, tests) and
`contracts/signguard-policy/src/logic.rs` (the TEE) — and **both are tested against the
same vectors** in `test-vectors/policy.json`.

## Measured costs & onboarding (testnet, 2026-11-19)

| Call (real TEE contract `z:…:signguard` v0.1.0) | Credits |
| --- | --- |
| `set-rules` (self call, writes private map) | ≈ 90 |
| `check` (self call, reads map, returns verdict) | ≈ 40 |
| One-time setup: create org + register 213 KB WASM + create map | ≈ 1,670 |
| Handshake / authenticate / `getBalance` / `getActivityLog` / `getContractVersion` | 0 |
| `tee:user` read (`getMemberDelegation`) | ≈ 30, and refused for a 0-credit DID ("required" 10,000) |

A fresh wallet-key DID authenticates for free but has 0 credits, and
`addOrganisationMember` refuses it ("can't attribute a non-user") until it is a
registered user (email-verified `user-upsert`). Options under evaluation: email-OTP
sign-in per user, a per-visitor org-owned agent DID, or T3-sponsored onboarding.
`npm run t3n:measure -- --yes` re-measures set-rules/check costs on the developer DID.

## Privacy model

* SignGuard never asks for, sees or stores a seed phrase or wallet private key, and never signs or broadcasts anything.
* Pasted transactions are decoded in memory and not stored.
* Rules: in real mode the server passes them through to the user's T3N vault and keeps no copy. The browser keeps a device-only copy so the editor can show them.
* Stats store only DIDs (pseudonymous), verdicts and tx kinds — no tx data, no IPs. The public dashboard shows truncated DIDs; the full list is behind `SIGNGUARD_ADMIN_TOKEN`.
* **v1 limitation (honest):** to keep the “1-minute, no wallet” try-out, each browser's T3N *identity* key is a throwaway key generated and held server-side, encrypted at rest (AES-256-GCM). It controls no funds, and the contract exposes no “read rules” function, but the operator could in principle act as that identity. v2 moves the key into the browser (or SIWE with the user's own wallet).

## Run it

```bash
npm install
npm test               # 58 TS tests (decoder, policy vectors, API, real adapter w/ mocked SDK)
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
4. `npm run t3n:setup -- --org --register` — creates (or reuses) the SignGuard org and
   registers `z:<tid>:signguard` + its private `rules` map. Guarded: it won't create a
   second org if `T3N_ORG_DID` is set or you already belong to one, and re-registering
   the same version is a no-op. Secrets go straight to the env file, never printed.
   (`--agent --fund N` only for delegated mode.)
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
