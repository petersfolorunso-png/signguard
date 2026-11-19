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
   user's did:t3n  ◀─────┤ 1. sign in: email → code (T3N email-OTP) → did:t3n, user-upsert
   (own T3N vault)       │    registers it, org adds it + sponsors credits, device key linked
                         │ 2. "Seal rules": self call set-rules → private map z:<tid>:rules
                         │ 3. every check: self call check (billed to + logged for the user DID)
                         ▼
          TEE contract z:<tid>:signguard (Rust → WASM, tenant-base world, no HTTP)
          reads the caller's rules, returns {verdict, codes}; labels the call
          {sg_op: check, verdict, hits} in T3N's tamper-evident activity log
```

* **`did:t3n` per user, via email code** — see "Sign-in" below. Signed-out visitors
  still get an instant *local preview* of any tx (default rules, no T3N call, not
  counted); signing in runs it in the enclave against their own rules.
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
  T3N only lets an org add *registered* users, which is why sign-in is by email.
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

## Sign-in: enter email, enter code, done

T3N's intended onboarding (SDK `createEmailOtpAuthInput` + `submitUserInput`):

1. `POST /api/auth/email/start {email}` — the server opens a T3N client and starts
   `authenticate(createEmailOtpAuthInput({email, getOtpCode}))`. T3N emails the code;
   the SDK then waits in `getOtpCode`, which we park (10 min, in memory) under a
   random `pendingId`.
2. `POST /api/auth/email/verify {pendingId, code}` — we hand the code to the parked
   login and get the user's DID (keyed on the email: same email → same DID). Then:
   * `submitUserInput({profile: {}, organisationDid})` — **user-upsert**: registers the
     profile. Per the SDK docs, an email-OTP login already proves the email, so we do
     *not* call `otpRequest` (that would send a second email).
   * org admin `addOrganisationMember` + `fundAgent(SIGNGUARD_USER_CREDITS)` (once per
     DID, within caps; "already a member" is tolerated).
   * `addAuthMethod(createEthAuthInput(deviceKey))` — links a throwaway device key to
     the DID so the browser resumes later without another email. If linking fails,
     the session still works until it expires, then asks for a new code.
3. The browser keeps only an opaque handle. **SignGuard never stores the email**
   (it passes through to T3N; tests assert it is not written to disk).

The SDK login is single-shot: a wrong code ends it and the UI offers "Send a new
code". Code sends are rate-limited (3 per address and 20 per IP per 10 min) on top
of T3N's own resend cooldown (`OtpRateLimitedError` → "try again in Ns").

**Does registration cost credits a new user lacks?** Evidence says no: on testnet a
fresh 0-credit DID's `user-upsert` call ran the contract and came back with the
contract's own `email_not_verified` refusal, not `InsufficientCredit` (whereas a
`tee:user` delegation read is refused up front for 0 credits), and its balance stayed
0. The org can't fund first anyway — `addOrganisationMember` refuses non-users — so
the order is: register (free) → add to org → fund. If T3N ever does charge for it,
the verify step fails with a clear 503 and sponsors nothing. Confirm in the first
live test (below).

**Mock mode** defaults to one-click anonymous DIDs for demos. `SIGNGUARD_LOGIN=email`
simulates the email flow: nothing is sent, the code is shown on screen
("Demo code: 123456"), and the same email maps to the same mock DID.

### First live test (needs Mari's OK + a chosen inbox)

With the real env loaded (`npm run build && npm start`, log shows `mode=real login=email`):
open the app → "Try a scary tx" (preview) → "Sign in & check privately" → enter the
chosen inbox → type the emailed code. Expect: welcome banner with "100 free T3
credits", the verdict re-runs as "Verdict from T3N enclave", and `/api/status` notes
show the org/contract. Then seal custom rules once and run one more check. Costs:
≈ 100 credits sponsored + whatever the user spends (≈ 90 rules + ≈ 40 per check)
from the user's sponsorship; registration itself should cost 0. Verify afterwards:
`npm run export:dids` lists the DID, and the org activity log has the `check` rows.

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
registered user (email-verified `user-upsert`) — hence email sign-in. A 0-credit
DID's `user-upsert` attempt was not refused for credits (see "Sign-in").
`npm run t3n:measure -- --yes` re-measures set-rules/check costs on the developer DID.

## Privacy model

* SignGuard never asks for, sees or stores a seed phrase or wallet private key, and never signs or broadcasts anything.
* Pasted transactions are decoded in memory and not stored.
* Rules: in real mode the server passes them through to the user's T3N vault and keeps no copy. The browser keeps a device-only copy so the editor can show them.
* Stats store only DIDs (pseudonymous), verdicts and tx kinds — no tx data, no IPs. The public dashboard shows truncated DIDs; the full list is behind `SIGNGUARD_ADMIN_TOKEN`.
* Email: used only to sign in with Terminal 3 (T3N keeps it on the user's profile as their verified contact). SignGuard's server never writes it to disk or logs; the pending login lives in memory for ≤10 minutes.
* **v1 limitation (honest):** so a visitor doesn't need a new email code every visit, a throwaway *device* key is linked to their DID, generated and held server-side, encrypted at rest (AES-256-GCM). It controls no funds, and the contract exposes no “read rules” function, but the operator could in principle act as that identity. v2 moves the key into the browser (or SIWE with the user's own wallet).

## Run it

```bash
npm install
npm test               # 79 TS tests (decoder, policy vectors, API, email sign-in, real adapter w/ mocked SDK)
npm run test:contract  # Rust TEE logic against the same vectors
npm run dev            # API :8787 + web :5173 (mock T3N)
SIGNGUARD_LOGIN=email npm run dev   # mock, with the email sign-in flow (code shown on screen)
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
| POST | `/api/session` | `{handle?}` → `{signedIn, handle?, did?, hasRules, loginMethod, mode}` (email mode never mints here) |
| POST | `/api/auth/email/start` | `{email}` → `{pendingId, expiresInSec, demoCode?}` (demoCode only in mock) |
| POST | `/api/auth/email/verify` | `{pendingId, code}` → `{handle, did, created, sponsored?, notes?}` |
| PUT | `/api/rules` | `{handle, rules}` → seals rules in the user's vault |
| POST | `/api/check` | `{handle?, input, chainId?, to?}` → facts, verdict, explanation (no signed-in handle in email mode → `policySource: "preview"`, `needsSignIn`) |
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
