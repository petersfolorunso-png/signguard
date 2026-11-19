/**
 * Measure real per-call costs on the developer DID (self calls on our TEE
 * contract). Spends ~170 test credits per run, so it needs --yes.
 */
if (!process.argv.includes("--yes")) { console.error("Spends ~170 test credits. Re-run with: npm run t3n:measure -- --yes"); process.exit(1); }
import { formatTokens, getContractVersion, getNodeUrl } from "@terminal3/t3n-sdk";
import { devSession, requireKey } from "./t3n-lib.js";
import { DEFAULT_RULES, toPolicyFacts } from "../src/core/rules.js";
import { decode } from "../src/core/decoder.js";
import { SAMPLES } from "../src/core/samples.js";
const red = (e: unknown) => String((e as Error)?.message ?? e).replace(/t3n_key_\S+/g, "<k>").slice(0, 400);
const { t3n } = await devSession(requireKey());
const C = process.env.T3N_CONTRACT!;
if (!C) { console.error("T3N_CONTRACT not set — run t3n:setup --register first"); process.exit(1); }
const bal = async () => (await t3n.getBalance()).available;
const f = formatTokens;
let b = await bal(); console.log("start", f(b));
const v = await getContractVersion(getNodeUrl(), C); console.log("contract version", v);
let n = await bal(); console.log("getContractVersion cost", f(b - n)); b = n;
const step = async (name: string, fn: () => Promise<unknown>) => {
  const s = Date.now();
  try { const r = await fn(); console.log(name, "->", JSON.stringify(r).slice(0, 300), `${Date.now() - s}ms`); } catch (e) { console.log(name, "err", red(e)); }
  const x = await bal(); console.log(name, "cost", f(b - x)); b = x;
};
await step("set-rules", () => t3n.executeAndDecode({ contract_id: C, contract_version: v, function_name: "set-rules", input: { rules: DEFAULT_RULES } }));
const facts = decode(SAMPLES[0].input).facts.map(toPolicyFacts);
await step("check#1 (scary)", () => t3n.executeAndDecode({ contract_id: C, contract_version: v, function_name: "check", input: { facts } }));
await step("check#2 (safe)", () => t3n.executeAndDecode({ contract_id: C, contract_version: v, function_name: "check", input: { facts: decode(SAMPLES[5].input).facts.map(toPolicyFacts) } }));
await step("activityLog", async () => { const p = await t3n.getActivityLog({ limit: 10, custom: { sg_op: "check" } }); return p.entries.map((e) => ({ fn: e.function, actor: e.actor.slice(-6), obo: e.on_behalf_of.slice(-6), outcome: e.outcome, custom: e.custom, type: e.caller_type })); });
