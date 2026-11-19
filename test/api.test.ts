import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createApp } from "../src/server/app";
import { MockT3n } from "../src/server/t3n/mock";
import { Usage } from "../src/server/usage";
import { SAMPLES } from "../src/core/samples";

let server: Server;
let base = "";
const dir = mkdtempSync(join(tmpdir(), "sg-"));
const usage = new Usage(join(dir, "usage.json"));
const mock = new MockT3n(join(dir, "mock.json"));

beforeAll(async () => {
  const app = createApp({
    adapter: mock,
    usage,
    adminToken: "test-admin-token",
    rateLimitPerMin: 1000,
    lookup: async (hash) => (hash === "0x" + "ab".repeat(32) ? { to: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", data: JSON.parse(SAMPLES[0].input).data, chainId: 42161 } : null),
  });
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => server?.close());

const post = (path: string, body: unknown, method = "POST") => fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

describe("API (mock T3N)", () => {
  let handle = "";
  let did = "";

  it("creates a session with a did:t3n", async () => {
    const r = await post("/api/session", {});
    expect(r.status).toBe(200);
    expect(r.body.did).toMatch(/^did:t3n:/);
    expect(r.body.created).toBe(true);
    handle = r.body.handle;
    did = r.body.did;
  });

  it("resumes the same DID for the same handle", async () => {
    const r = await post("/api/session", { handle });
    expect(r.body).toMatchObject({ did, created: false });
  });

  it("one-click scary sample → block, with explanation", async () => {
    const r = await post("/api/check", { handle, input: SAMPLES[0].input });
    expect(r.status).toBe(200);
    expect(r.body.result.verdict).toBe("block");
    expect(r.body.explanation.headline).toMatch(/unlimited USDC/);
    expect(r.body.policySource).toBe("mock-tee");
    expect(r.body.did).toBe(did);
  });

  it("rules are applied: raise leverage cap → 50x passes the leverage rule", async () => {
    const hl = SAMPLES.find((s) => s.id === "hl-50x")!.input;
    expect((await post("/api/check", { handle, input: hl })).body.result.verdict).toBe("block");
    expect((await post("/api/rules", { handle, rules: { maxLeverage: 100 } }, "PUT")).status).toBe(200);
    expect((await post("/api/check", { handle, input: hl })).body.result.verdict).toBe("allow");
  });

  it("policy response never echoes the rules", async () => {
    await post("/api/rules", { handle, rules: { maxSpendUsd: 777, allowlist: ["0x000000000022d473030f116ddee9f6b43ac78ba3"] } }, "PUT");
    const r = await post("/api/check", { handle, input: SAMPLES[0].input });
    const s = JSON.stringify(r.body);
    expect(s).not.toContain("777");
    expect(s).not.toMatch(/"maxSpendUsd"|"allowlist"|"maxLeverage"/);
  });

  it("resolves tx hashes", async () => {
    const r = await post("/api/check", { handle, input: "0x" + "ab".repeat(32) });
    expect(r.body.source).toBe("hash");
    expect(r.body.result.verdict).toBe("block");
    expect((await post("/api/check", { handle, input: "0x" + "cd".repeat(32) })).status).toBe(404);
  });

  it("rejects bad input", async () => {
    expect((await post("/api/check", { handle: "nope", input: "x" })).status).toBe(400);
    expect((await post("/api/check", { handle, input: "" })).status).toBe(400);
    expect((await post("/api/rules", { handle, rules: { allowlist: ["bad"] } }, "PUT")).status).toBe(400);
  });

  it("public stats count unique DIDs and checks, truncating DIDs", async () => {
    await post("/api/session", {}); // second user, no checks yet
    const r = await fetch(base + "/api/stats").then((x) => x.json());
    expect(r.uniqueDids).toBe(2);
    expect(r.activeDids).toBe(1);
    expect(r.totals.checks).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(r.recent)).not.toContain(did);
  });

  it("DID export needs the admin token and includes T3N log counts", async () => {
    expect((await fetch(base + "/api/admin/dids")).status).toBe(403);
    const r = await fetch(base + "/api/admin/dids", { headers: { "x-admin-token": "test-admin-token" } }).then((x) => x.json());
    expect(r.count).toBe(2);
    const me = r.dids.find((d: any) => d.did === did);
    expect(me.checks).toBeGreaterThanOrEqual(5);
    expect(me.t3nCalls).toBe(me.checks);
    const csv = await fetch(base + "/api/admin/dids?format=csv", { headers: { "x-admin-token": "test-admin-token" } }).then((x) => x.text());
    expect(csv.split("\n")[0]).toBe("did,first_seen,last_seen,checks,t3n_logged_calls");
  });

  it("usage file stores no tx input or rules", async () => {
    usage.flush();
    mock.flush();
    const raw = readFileSync(join(dir, "usage.json"), "utf8");
    expect(raw).not.toContain("0x095ea7b3");
    expect(raw).not.toContain("maxLeverage");
    expect(existsSync(join(dir, "mock.json"))).toBe(true);
  });
});
