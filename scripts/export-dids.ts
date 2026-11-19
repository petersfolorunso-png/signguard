/**
 * Export every DID that used SignGuard, for the DoraHacks form
 * ("List all the DIDs involved in your build"). Reads the running server's
 * admin endpoint so it merges local stats with the T3N activity log.
 *
 *   SIGNGUARD_URL=http://localhost:8787 npm run export:dids
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadSecretsFile } from "../src/server/config.js";

loadSecretsFile();
const url = process.env.SIGNGUARD_URL ?? "http://localhost:8787";
const token = process.env.SIGNGUARD_ADMIN_TOKEN;
if (!token) { console.error("SIGNGUARD_ADMIN_TOKEN not set"); process.exit(1); }
const h = { "x-admin-token": token };
const json = await fetch(`${url}/api/admin/dids`, { headers: h }).then((r) => r.json());
const csv = await fetch(`${url}/api/admin/dids?format=csv`, { headers: h }).then((r) => r.text());
mkdirSync("data/exports", { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
writeFileSync(`data/exports/dids-${stamp}.csv`, csv);
writeFileSync(`data/exports/dids-${stamp}.json`, JSON.stringify(json, null, 2));
console.log(`${json.count} DIDs (mode=${json.mode}) → data/exports/dids-${stamp}.{csv,json}${json.logError ? `\nT3N log read failed: ${json.logError}` : ""}`);
