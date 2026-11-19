import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  T3nClient, setEnvironment, loadWasmComponent, resolveTrustAnchor, eth_get_address, metamask_sign, createEthAuthInput,
} from "@terminal3/t3n-sdk";
import { loadSecretsFile } from "../src/server/config.js";

export const SECRETS = process.env.T3_ENV_FILE ?? join(homedir(), ".secrets/terminal3/t3.env");

export function env(): "testnet" | "production" {
  const e = (process.env.T3N_ENV ?? "testnet") as "testnet" | "production";
  setEnvironment(e);
  return e;
}

export function requireKey(): string {
  const s = loadSecretsFile(SECRETS);
  if (s.warning) console.warn("WARNING:", s.warning);
  const k = process.env.T3N_API_KEY;
  if (!k) {
    console.error(`T3N_API_KEY not set. Put it in ${SECRETS} (chmod 600) as T3N_API_KEY=...`);
    process.exit(1);
  }
  return k;
}

/** Authenticated developer session (same as the docs' quickstart). */
export async function devSession(key: string) {
  const e = env();
  const wasmComponent = await loadWasmComponent();
  const address = eth_get_address(key);
  const t3n = new T3nClient({ trustAnchor: await resolveTrustAnchor(e), wasmComponent, handlers: { EthSign: metamask_sign(address, undefined, key) } });
  await t3n.handshake();
  const did = (await t3n.authenticate(createEthAuthInput(address))).value;
  return { t3n, did, e };
}

/** Append/replace KEY=VALUE in the secrets file without printing the value. */
export function storeSecret(name: string, value: string) {
  mkdirSync(dirname(SECRETS), { recursive: true, mode: 0o700 });
  const lines = existsSync(SECRETS) ? readFileSync(SECRETS, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith(`${name}=`)) : [];
  lines.push(`${name}=${value}`);
  writeFileSync(SECRETS, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(SECRETS, 0o600);
  process.env[name] = value;
}
export { appendFileSync };
