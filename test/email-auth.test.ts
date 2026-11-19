/** Email-code sign-in through the HTTP API, on the mock adapter (no email is sent). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createApp } from "../src/server/app";
import { MockT3n } from "../src/server/t3n/mock";
import { Usage } from "../src/server/usage";
import { SAMPLES } from "../src/core/samples";

let server: Server;
let base = "";
const dir = mkdtempSync(join(tmpdir(), "sge-"));
const usage = new Usage(join(dir, "usage.json"));
const mock = new MockT3n(join(dir, "mock.json"), { loginMethod: "email" });

beforeAll(async () => {
  const app = createApp({ adapter: mock, usage, rateLimitPerMin: 1000 });
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => server?.close());

const post = (path: string, body: unknown, method = "POST") =>
  fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const scary = SAMPLES.find((s) => s.id === "unlimited-usdc")!.input;

describe("email sign-in (mock)", () => {
  let handle = "";
  let did = "";

  it("status advertises email login", async () => {
    const r = await fetch(base + "/api/status").then((x) => x.json());
    expect(r.loginMethod).toBe("email");
  });

  it("no handle -> signed out (no identity minted)", async () => {
    const r = await post("/api/session", {});
    expect(r.body).toMatchObject({ signedIn: false, loginMethod: "email" });
    expect(r.body.did).toBeUndefined();
  });

  it("signed-out check returns a local preview, not counted", async () => {
    const before = usage.stats().totals.checks;
    const r = await post("/api/check", { input: scary });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ policySource: "preview", needsSignIn: true, result: { verdict: "block" } });
    expect(r.body.did).toBeUndefined();
    expect(usage.stats().totals.checks).toBe(before);
  });

  it("saving rules needs sign-in (401 + signIn flag)", async () => {
    const r = await post("/api/rules", { rules: {} }, "PUT");
    expect(r.status).toBe(401);
    expect(r.body.signIn).toBe(true);
  });

  it("rejects a bad email", async () => {
    const r = await post("/api/auth/email/start", { email: "not-an-email" });
    expect(r.status).toBe(400);
  });

  it("wrong code -> 400, right code -> did:t3n", async () => {
    const s = await post("/api/auth/email/start", { email: "Visitor@Example.com" });
    expect(s.status).toBe(200);
    expect(s.body.demoCode).toMatch(/^\d{6}$/);
    const wrong = String((Number(s.body.demoCode) + 1) % 1000000).padStart(6, "0");
    expect((await post("/api/auth/email/verify", { pendingId: s.body.pendingId, code: wrong })).status).toBe(400);
    const v = await post("/api/auth/email/verify", { pendingId: s.body.pendingId, code: s.body.demoCode });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ signedIn: true, created: true });
    expect(v.body.did).toMatch(/^did:t3n:mock/);
    expect(v.body.handle).toMatch(/^[a-f0-9]{32}$/);
    handle = v.body.handle;
    did = v.body.did;
    // the code is single use
    expect((await post("/api/auth/email/verify", { pendingId: s.body.pendingId, code: s.body.demoCode })).status).toBe(410);
  });

  it("signed-in session resumes; checks run in the (mock) enclave and count", async () => {
    const s = await post("/api/session", { handle });
    expect(s.body).toMatchObject({ signedIn: true, did });
    const r = await post("/api/check", { handle, input: scary });
    expect(r.body).toMatchObject({ did, policySource: "mock-tee", result: { verdict: "block" } });
    expect(usage.stats().totals.checks).toBe(1);
    expect((await post("/api/rules", { handle, rules: {} }, "PUT")).status).toBe(200);
  });

  it("same email again -> same DID (keyed on the email, like T3N)", async () => {
    const s = await post("/api/auth/email/start", { email: "visitor@example.com" });
    const v = await post("/api/auth/email/verify", { pendingId: s.body.pendingId, code: s.body.demoCode });
    expect(v.body.did).toBe(did);
    expect(v.body.created).toBe(false);
  });

  it("the email itself is never written to disk", () => {
    mock.flush();
    usage.flush();
    for (const f of ["mock.json", "usage.json"]) expect(readFileSync(join(dir, f), "utf8")).not.toMatch(/visitor@/i);
  });

  it("rate-limits code requests per address", async () => {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await post("/api/auth/email/start", { email: "spam@example.com" })).status);
    expect(codes).toEqual([200, 200, 200, 429]);
  });
});
