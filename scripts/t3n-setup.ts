/**
 * One-time T3N setup for SignGuard. Every step is opt-in by flag and guarded,
 * because creating an org is NOT idempotent (docs). Secrets go straight into
 * ~/.secrets/terminal3/t3.env (chmod 600) and are never printed.
 *
 *   npm run t3n:setup -- --org        create the organisation (once)
 *   npm run t3n:setup -- --agent      create the SignGuard agent (once)
 *   npm run t3n:setup -- --fund 50    move 50 test credits to the agent
 *   npm run t3n:setup -- --register   build artefact -> register contract + private map
 *   npm run t3n:setup -- --status     show what's configured
 */
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { TenantClient, getNodeUrl, toBaseUnits, formatTokens } from "@terminal3/t3n-sdk";
import { devSession, requireKey, storeSecret, SECRETS } from "./t3n-lib.js";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => args[args.indexOf(f) + 1];

const TAIL = "signguard";
const VERSION = process.env.SIGNGUARD_CONTRACT_VERSION ?? "0.1.0";
const WASM = "contracts/signguard-policy/target/wasm32-wasip2/release/signguard_policy.wasm";

const { t3n, did: tenantDid } = await devSession(requireKey());
console.log(`Developer DID: ${tenantDid}`);

if (!process.env.SIGNGUARD_KEY_SECRET) {
  storeSecret("SIGNGUARD_KEY_SECRET", randomBytes(32).toString("hex"));
  console.log("Generated SIGNGUARD_KEY_SECRET (stored, not shown).");
}
if (!process.env.SIGNGUARD_ADMIN_TOKEN) {
  storeSecret("SIGNGUARD_ADMIN_TOKEN", randomBytes(24).toString("hex"));
  console.log("Generated SIGNGUARD_ADMIN_TOKEN for the DID export (stored, not shown).");
}

if (has("--org")) {
  if (process.env.T3N_ORG_DID) console.log(`Org already set: ${process.env.T3N_ORG_DID} — not creating another.`);
  else {
    const existing = (await t3n.myOrgs()).map((d) => d.value);
    const org = existing[0] ?? (await t3n.createOrganisation("SignGuard")).value;
    storeSecret("T3N_ORG_DID", org);
    console.log(`${existing[0] ? "Using existing" : "Created"} organisation ${org}`);
  }
}

if (has("--agent")) {
  if (process.env.T3N_AGENT_DID) console.log(`Agent already set: ${process.env.T3N_AGENT_DID}`);
  else {
    const org = process.env.T3N_ORG_DID;
    if (!org) throw new Error("run --org first");
    const agent = await t3n.createAgent(org, "SignGuard");
    storeSecret("T3N_AGENT_DID", agent.agentDid.value);
    storeSecret("T3N_AGENT_API_KEY", agent.apiKey); // shown once by T3N — saved, never printed
    console.log(`Created agent ${agent.agentDid.value} (API key saved to ${SECRETS})`);
  }
}

if (has("--fund")) {
  const n = Number(val("--fund"));
  if (!(n > 0 && n <= 1000)) throw new Error("--fund <credits> between 1 and 1000");
  if (!process.env.T3N_AGENT_DID) throw new Error("run --agent first");
  const before = await t3n.getBalance();
  console.log(`Your balance: ${formatTokens(before.available)} credits. Funding agent with ${n}…`);
  await t3n.fundAgent(process.env.T3N_AGENT_DID, toBaseUnits(n));
  console.log("Funded.");
}

if (has("--register")) {
  const tenant = new TenantClient({ t3n, baseUrl: getNodeUrl(), tenantDid });
  await tenant.tenant.me();
  const contractName = `z:${tenantDid.slice("did:t3n:".length)}:${TAIL}`;
  const reg = await tenant.contracts.register({ tail: TAIL, version: VERSION, wasm: await readFile(WASM) });
  const id = reg.contract_id;
  console.log(`Registered ${contractName} v${VERSION} as contract id ${id}`);
  storeSecret("T3N_CONTRACT", contractName);
  storeSecret(`T3N_CONTRACT_ID_${VERSION.replace(/\W/g, "_")}`, String(id));
  const acl = { writers: { only: [id] }, readers: { only: [id] } };
  try {
    await tenant.maps.create({ tail: "rules", visibility: "private", ...acl });
    console.log(`Created private map z:…:rules for contract ${id}`);
  } catch (e) {
    if (!/already.?exists/i.test(String((e as Error).message))) throw e;
    await tenant.maps.update("rules", acl);
    console.log(`Map existed — re-pointed to contract ${id}`);
  }
}

if (has("--status") || args.length === 0) {
  for (const k of ["T3N_ORG_DID", "T3N_AGENT_DID", "T3N_AGENT_API_KEY", "T3N_CONTRACT", "SIGNGUARD_KEY_SECRET", "SIGNGUARD_ADMIN_TOKEN"]) {
    const v = process.env[k];
    console.log(`${k.padEnd(22)} ${v ? (/KEY|SECRET|TOKEN/.test(k) ? "set (hidden)" : v) : "—"}`);
  }
  console.log(`Balance: ${formatTokens((await t3n.getBalance()).available)} credits`);
}
