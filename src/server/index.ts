import express from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appConfig, loadSecretsFile } from "./config.js";
import { createApp } from "./app.js";
import { MockT3n } from "./t3n/mock.js";
import { Usage } from "./usage.js";
import type { T3nAdapter } from "./t3n/adapter.js";

const secrets = loadSecretsFile();
if (secrets.warning) console.warn(`[signguard] WARNING: ${secrets.warning}`);
const cfg = appConfig();

let adapter: T3nAdapter;
if (cfg.mode === "real") {
  const { RealT3n } = await import("./t3n/real.js");
  adapter = new RealT3n({
    env: (process.env.T3N_ENV as "testnet" | "production") ?? "testnet",
    devKey: process.env.T3N_API_KEY!,
    orgDid: process.env.T3N_ORG_DID,
    userMode: process.env.T3N_USER_MODE === "delegated" ? "delegated" : "self",
    userCredits: Number(process.env.SIGNGUARD_USER_CREDITS ?? 5),
    userCreditCap: Number(process.env.SIGNGUARD_USER_CREDIT_CAP ?? 25),
    dailyBudget: Number(process.env.SIGNGUARD_DAILY_CREDIT_BUDGET ?? 1000),
    agentApiKey: process.env.T3N_AGENT_API_KEY,
    agentDid: process.env.T3N_AGENT_DID,
    contract: process.env.T3N_CONTRACT!,
    keySecret: process.env.SIGNGUARD_KEY_SECRET!,
    dataDir: cfg.dataDir,
  });
} else {
  adapter = new MockT3n(join(cfg.dataDir, "mock-t3n.json"));
}

const usage = new Usage(join(cfg.dataDir, `usage-${cfg.mode}.json`));
const app = createApp({ adapter, usage, adminToken: cfg.adminToken, prices: cfg.prices });

const dist = join(process.cwd(), "dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dist, "index.html")));
}

const server = app.listen(cfg.port, () => {
  console.log(`[signguard] http://localhost:${cfg.port}  mode=${cfg.mode}${cfg.mode === "mock" ? ` (missing for real T3N: ${cfg.missing.join(", ")})` : ""}  secrets=${secrets.loaded ? "loaded" : "none"}`);
});
const stop = () => { usage.flush(); server.close(() => process.exit(0)); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
