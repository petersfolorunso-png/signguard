/**
 * Create (or update env + redeploy) the SignGuard FREE Render web service.
 * Reads secrets from ~/.secrets/terminal3/t3.env and ~/.secrets/render/render.env;
 * never prints values. Needs Render's GitHub app to have access to
 * petersfolorunso-png/signguard (private).
 *
 *   npx tsx scripts/render-deploy.ts            # create if missing, else push env + deploy
 *   npx tsx scripts/render-deploy.ts --status   # show service URL + latest deploy
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OWNER = "tea-dbvc20p5efls73ddcetg"; // workspace "Mari Space"
const NAME = "signguard";
const REPO = "https://github.com/petersfolorunso-png/signguard";

function readEnv(p: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2].trim()) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}
const key = readEnv(join(homedir(), ".secrets/render/render.env")).RENDER_API_KEY;
const env = { ...readEnv(join(homedir(), ".secrets/terminal3/t3.env")), SIGNGUARD_MODE: "real", SIGNGUARD_LOGIN: "email", NODE_VERSION: "24" };
delete (env as Record<string, string>).T3_ENV_FILE;

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`https://api.render.com/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${j.message ?? ""}`);
  return j;
}

const list = await api("GET", `/services?name=${NAME}&ownerId=${OWNER}`);
let svc = list[0]?.service;
if (process.argv.includes("--status")) {
  if (!svc) { console.log("no service yet"); process.exit(0); }
  const deploys = await api("GET", `/services/${svc.id}/deploys?limit=1`);
  console.log({ id: svc.id, url: svc.serviceDetails?.url, plan: svc.serviceDetails?.plan, deploy: deploys[0]?.deploy?.status });
  process.exit(0);
}
const envVars = Object.entries(env).sort().map(([k, value]) => ({ key: k, value }));
if (!svc) {
  const res = await api("POST", "/services", {
    type: "web_service", name: NAME, ownerId: OWNER, repo: REPO, branch: "main", autoDeploy: "no",
    serviceDetails: { runtime: "node", plan: "free", region: "frankfurt", healthCheckPath: "/api/status", envSpecificDetails: { buildCommand: "npm ci --include=dev && npm run build", startCommand: "npm start" } },
    envVars,
  });
  svc = res.service;
  console.log("created", svc.id, svc.serviceDetails?.url, "deploy", res.deployId);
} else {
  if (svc.serviceDetails?.plan !== "free") throw new Error(`refusing: service plan is ${svc.serviceDetails?.plan}, expected free`);
  await api("PUT", `/services/${svc.id}/env-vars`, envVars);
  const d = await api("POST", `/services/${svc.id}/deploys`, {});
  console.log("env updated (", envVars.length, "vars ), deploy", d.id, svc.serviceDetails?.url);
}
