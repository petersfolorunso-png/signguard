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

// Durable state (identities, sponsorship ledger, usage) in the D1-backed store, when configured.
let store: import("./remote-store.js").RemoteStore | null = null;
if (process.env.SIGNGUARD_STORE_URL && process.env.SIGNGUARD_STORE_TOKEN) {
  const { RemoteStore, useRemoteStore } = await import("./remote-store.js");
  store = new RemoteStore(process.env.SIGNGUARD_STORE_URL, process.env.SIGNGUARD_STORE_TOKEN);
  // Refuse to start on a load failure: starting empty could re-gift credits.
  const docs = await store.load();
  useRemoteStore(store, docs);
  console.log(`[signguard] state store: ${Object.keys(docs).length} docs loaded`);
} else if (cfg.mode === "real") {
  console.warn("[signguard] WARNING: no SIGNGUARD_STORE_URL; state lives on local disk only");
}

let adapter: T3nAdapter;
if (cfg.mode === "real") {
  const { RealT3n } = await import("./t3n/real.js");
  adapter = new RealT3n({
    env: (process.env.T3N_ENV as "testnet" | "production") ?? "testnet",
    devKey: process.env.T3N_API_KEY!,
    orgDid: process.env.T3N_ORG_DID,
    userMode: process.env.T3N_USER_MODE === "delegated" ? "delegated" : "self",
    // Email-code sign-in makes each visitor a registered user the org can sponsor.
    loginMethod: process.env.SIGNGUARD_LOGIN === "anonymous" ? "anonymous" : "email",
    // Measured on testnet 2026-11-19: check ≈ 40 credits, set-rules ≈ 90.
    // 100 = ~2 checks on default rules; cap 300 = rules save + ~5 checks.
    userCredits: Number(process.env.SIGNGUARD_USER_CREDITS ?? 100),
    userCreditCap: Number(process.env.SIGNGUARD_USER_CREDIT_CAP ?? 300),
    dailyBudget: Number(process.env.SIGNGUARD_DAILY_CREDIT_BUDGET ?? 1500),
    agentApiKey: process.env.T3N_AGENT_API_KEY,
    agentDid: process.env.T3N_AGENT_DID,
    contract: process.env.T3N_CONTRACT!,
    keySecret: process.env.SIGNGUARD_KEY_SECRET!,
    dataDir: cfg.dataDir,
  });
} else {
  // Mock defaults to one-click anonymous DIDs; SIGNGUARD_LOGIN=email simulates the email flow (code shown on screen, nothing sent).
  adapter = new MockT3n(join(cfg.dataDir, "mock-t3n.json"), { loginMethod: process.env.SIGNGUARD_LOGIN === "email" ? "email" : "anonymous" });
}

const usage = new Usage(join(cfg.dataDir, `usage-${cfg.mode}.json`));
const app = createApp({ adapter, usage, adminToken: cfg.adminToken, prices: cfg.prices });

const dist = join(process.cwd(), "dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dist, "index.html")));
}

const server = app.listen(cfg.port, () => {
  console.log(`[signguard] http://localhost:${cfg.port}  mode=${cfg.mode} login=${adapter.loginMethod}${cfg.mode === "mock" ? ` (missing for real T3N: ${cfg.missing.join(", ")})` : ""}  secrets=${secrets.loaded ? "loaded" : "none"}`);
});
const stop = () => {
  usage.flush();
  server.close(async () => {
    await store?.drain();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
