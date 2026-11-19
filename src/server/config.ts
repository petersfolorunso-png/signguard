import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Load KEY=VALUE pairs from the secrets file into process.env (never logged). */
export function loadSecretsFile(path = process.env.T3_ENV_FILE ?? join(homedir(), ".secrets/terminal3/t3.env")): { loaded: boolean; path: string; warning?: string } {
  if (!existsSync(path)) return { loaded: false, path };
  let warning: string | undefined;
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) warning = `${path} is readable by others (mode ${mode.toString(8)}); run: chmod 600 ${path}`;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return { loaded: true, path, warning };
}

export interface AppConfig {
  port: number;
  dataDir: string;
  adminToken?: string;
  mode: "mock" | "real";
  missing: string[];
  prices: boolean;
}

export const REAL_VARS_SELF = ["T3N_API_KEY", "T3N_ORG_DID", "T3N_CONTRACT", "SIGNGUARD_KEY_SECRET"] as const;
export const REAL_VARS_DELEGATED = ["T3N_API_KEY", "T3N_AGENT_API_KEY", "T3N_AGENT_DID", "T3N_CONTRACT", "SIGNGUARD_KEY_SECRET"] as const;

export function appConfig(): AppConfig {
  const vars = process.env.T3N_USER_MODE === "delegated" ? REAL_VARS_DELEGATED : REAL_VARS_SELF;
  const missing = vars.filter((k) => !process.env[k]);
  const forced = process.env.SIGNGUARD_MODE;
  const mode = forced === "mock" ? "mock" : forced === "real" || missing.length === 0 ? "real" : "mock";
  if (mode === "real" && missing.length) throw new Error(`SIGNGUARD_MODE=real but missing: ${missing.join(", ")}`);
  return {
    port: Number(process.env.PORT ?? 8787),
    dataDir: process.env.SIGNGUARD_DATA_DIR ?? join(process.cwd(), "data"),
    adminToken: process.env.SIGNGUARD_ADMIN_TOKEN || undefined,
    mode,
    missing,
    prices: process.env.SIGNGUARD_PRICES !== "off",
  };
}
