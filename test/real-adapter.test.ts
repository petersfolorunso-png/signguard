/** RealT3n with the SDK mocked: checks call names, sponsorship and caps (no network). */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const calls: { fn: string; args: unknown[] }[] = [];
let balances: Record<string, number> = {};
let nextDid = 0;
const emailDids: Record<string, string> = {};
const linked: Record<string, string> = {};
const sent: string[] = [];
const sdkKnobs = { upsertError: null as null | string, otpRateLimited: false };
const GOOD_CODE = "246810";

vi.mock("@terminal3/t3n-sdk", () => {
  class T3nClient {
    did = "";
    constructor(public cfg: any) {}
    async handshake() {}
    async authenticate(input: any) {
      if (input?.method === "email_otp") {
        const email = input.credentials.email;
        if (sdkKnobs.otpRateLimited) { const e: any = new Error("cooldown_active"); e.name = "OtpRateLimitedError"; e.retryAfterSecs = 42; throw e; }
        sent.push(email);
        const code = await input.credentials.getOtpCode();
        if (code !== GOOD_CODE) throw new Error("login refused: invalid code");
        this.did = emailDids[email] ??= `did:t3n:${(++nextDid).toString(16).padStart(40, "0")}`;
        calls.push({ fn: "authenticate:email", args: [] });
        return { value: this.did };
      }
      this.did = linked[input?.a] ?? `did:t3n:${(++nextDid).toString(16).padStart(40, "0")}`;
      return { value: this.did };
    }
    async submitUserInput(args: any) {
      calls.push({ fn: "submitUserInput", args: [this.did, args] });
      if (sdkKnobs.upsertError) throw new Error(sdkKnobs.upsertError);
      return {};
    }
    async addAuthMethod(input: any) { calls.push({ fn: "addAuthMethod", args: [this.did] }); linked[input.a] = this.did; return { value: this.did }; }
    async addOrganisationMember(org: string, did: string) { calls.push({ fn: "addOrganisationMember", args: [org, did] }); }
    async fundAgent(did: string, amt: number) { calls.push({ fn: "fundAgent", args: [did, amt] }); balances[did] = (balances[did] ?? 0) + amt; return { seqNo: 1 }; }
    async executeAndDecode(p: any) {
      calls.push({ fn: `exec:${p.function_name}`, args: [this.did, p.input] });
      if ((balances[this.did] ?? 0) <= 0) throw new Error(`InsufficientCredit (account=x, required=1, available=0)`);
      balances[this.did] -= 1_000_000;
      return p.function_name === "check" ? { verdict: "block", codes: [{ code: "unlimited_approval", severity: "block" }] } : { stored: true };
    }
    async updateMemberDelegation() { calls.push({ fn: "updateMemberDelegation", args: [] }); }
    async getActivityLog() { return { entries: [], next_seq: null }; }
  }
  return {
    T3nClient,
    toBaseUnits: (n: number) => n * 1_000_000,
    setEnvironment: () => {},
    getNodeUrl: () => "https://node.test",
    loadWasmComponent: async () => ({}),
    resolveTrustAnchor: async () => ({}),
    eth_get_address: (k: string) => "0x" + k.slice(-40),
    metamask_sign: () => () => {},
    createEthAuthInput: (a: string) => ({ a }),
    createEmailOtpAuthInput: (credentials: any) => ({ method: "email_otp", credentials }),
    getContractVersion: async () => "0.1.0",
    fanOutGrant: (g: any, fns: string[]) => fns.map((f) => ({ ...g, function: f })),
    invoke: async () => ({ verdict: "allow", codes: [] }),
    InvokeError: class extends Error {},
  };
});

const { RealT3n } = await import("../src/server/t3n/real");
const DEV = "0x" + "11".repeat(32);
const make = (over: Partial<ConstructorParameters<typeof RealT3n>[0]> = {}) =>
  new RealT3n({ env: "testnet", devKey: DEV, orgDid: "did:t3n:org", userMode: "self", loginMethod: "anonymous", userCredits: 5, userCreditCap: 10, dailyBudget: 1000, contract: "z:abc:signguard", keySecret: "s".repeat(32), dataDir: mkdtempSync(join(tmpdir(), "sgr-")), ...over });

beforeEach(() => { calls.length = 0; balances = {}; sent.length = 0; sdkKnobs.upsertError = null; sdkKnobs.otpRateLimited = false; });

const RULES = { blockUnlimitedApprovals: true, blockApprovalForAll: true, maxSpendUsd: 1, maxLeverage: 1, allowlist: [], unlistedContract: "warn" as const, permitSignatures: "warn" as const, maxPermitDays: 1 };

describe("RealT3n email sign-in", () => {
  it("email code -> registered DID (user-upsert w/ org) -> org member + funded -> device key linked; then self calls", async () => {
    const t = make({ loginMethod: "email" });
    const start = await t.startEmailLogin("  Alice@Example.com ");
    expect(start.demoCode).toBeUndefined(); // real mode never reveals a code
    expect(sent).toEqual(["alice@example.com"]);
    const done = await t.verifyEmailLogin(start.pendingId, GOOD_CODE);
    expect(done.created).toBe(true);
    expect(done.sponsored).toBe(5);
    expect(done.handle).toMatch(/^[a-f0-9]{32}$/);
    expect(calls.map((c) => c.fn)).toEqual(["authenticate:email", "submitUserInput", "addOrganisationMember", "fundAgent", "addAuthMethod"]);
    expect((calls[1].args[1] as any).organisationDid).toBe("org");
    expect((calls[1].args[1] as any).profile).toEqual({ first_name: "SignGuard", last_name: "User" }); // T3N requires both // bare hex, no did:t3n: prefix (T3N wants 40 hex)
    expect(calls[2].args).toEqual(["did:t3n:org", done.did]);
    expect(await t.isSignedIn(done.handle)).toBe(true);
    await t.saveRules(done.handle, RULES);
    const r = await t.check(done.handle, [{ kind: "approve", unlimited: true }]);
    expect(r.verdict).toBe("block");
    expect(calls.filter((c) => c.fn.startsWith("exec:")).map((c) => c.args[0])).toEqual([done.did, done.did]);
  });

  it("passes the visitor's optional name to user-upsert", async () => {
    const t = make({ loginMethod: "email" });
    await t.verifyEmailLogin((await t.startEmailLogin("ivy@example.com")).pendingId, GOOD_CODE, "Ivy  Ada Okafor");
    expect((calls.find((c) => c.fn === "submitUserInput")!.args[1] as any).profile).toEqual({ first_name: "Ivy", last_name: "Ada Okafor" });
  });

  it("server never persists the email address", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sgr-"));
    const t = make({ loginMethod: "email", dataDir: dir });
    const s = await t.startEmailLogin("secret.person@example.org");
    await t.verifyEmailLogin(s.pendingId, GOOD_CODE);
    (t as any).ids.flush?.();
    const { readdirSync, readFileSync } = await import("node:fs");
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), "utf8")).not.toMatch(/secret\.person/);
  });

  it("returning user on a new browser: same DID, no second registration or sponsorship", async () => {
    const t = make({ loginMethod: "email" });
    const a = await t.verifyEmailLogin((await t.startEmailLogin("bob@example.com")).pendingId, GOOD_CODE);
    calls.length = 0;
    const b = await t.verifyEmailLogin((await t.startEmailLogin("bob@example.com")).pendingId, GOOD_CODE);
    expect(b.did).toBe(a.did);
    expect(b.created).toBe(false);
    expect(b.handle).not.toBe(a.handle);
    expect(calls.map((c) => c.fn)).toEqual(["authenticate:email", "addAuthMethod"]);
  });

  it("wrong code ends the login with a clear message; the pending id can't be reused", async () => {
    const t = make({ loginMethod: "email" });
    const s = await t.startEmailLogin("carol@example.com");
    await expect(t.verifyEmailLogin(s.pendingId, "000000")).rejects.toThrow(/didn't work/);
    await expect(t.verifyEmailLogin(s.pendingId, GOOD_CODE)).rejects.toThrow(/expired/);
    expect(calls.some((c) => c.fn === "submitUserInput")).toBe(false);
  });

  it("a failure after the code is redeemed can be retried without a new email", async () => {
    const t = make({ loginMethod: "email" });
    const s = await t.startEmailLogin("hal@example.com");
    sdkKnobs.upsertError = "input: organisation_did must be 40 hex chars, got 48";
    await expect(t.verifyEmailLogin(s.pendingId, GOOD_CODE)).rejects.toThrow(/press Verify again/);
    sdkKnobs.upsertError = null;
    const d = await t.verifyEmailLogin(s.pendingId, GOOD_CODE);
    expect(d.did).toMatch(/^did:t3n:/);
    expect(sent).toEqual(["hal@example.com"]);
    expect(calls.filter((c) => c.fn === "authenticate:email")).toHaveLength(1);
    await expect(t.verifyEmailLogin(s.pendingId, GOOD_CODE)).rejects.toThrow(/expired/); // consumed on success
  });

  it("maps T3N's resend throttle to a 429 with retryAfter", async () => {
    const t = make({ loginMethod: "email" });
    sdkKnobs.otpRateLimited = true;
    await expect(t.startEmailLogin("dan@example.com")).rejects.toMatchObject({ status: 429, retryAfterSecs: 42 });
  });

  it("if registration ever needs credits, says so (can't pre-fund a non-user) and doesn't sponsor", async () => {
    const t = make({ loginMethod: "email" });
    sdkKnobs.upsertError = "InsufficientCredit (account=x, required=10, available=0)";
    const s = await t.startEmailLogin("erin@example.com");
    await expect(t.verifyEmailLogin(s.pendingId, GOOD_CODE)).rejects.toMatchObject({ status: 503 });
    expect(calls.some((c) => c.fn === "fundAgent")).toBe(false);
  });

  it("an 'already a member' refusal from addOrganisationMember is fine (user-upsert attributed them)", async () => {
    const t = make({ loginMethod: "email" });
    const proto = (await import("@terminal3/t3n-sdk")).T3nClient.prototype as any;
    const add = proto.addOrganisationMember;
    proto.addOrganisationMember = async () => { throw new Error("member already in organisation"); };
    try {
      const d = await t.verifyEmailLogin((await t.startEmailLogin("fay@example.com")).pendingId, GOOD_CODE);
      expect(d.sponsored).toBe(5);
    } finally { proto.addOrganisationMember = add; }
  });

  it("linked device key resumes the session without email after the cache expires", async () => {
    const t = make({ loginMethod: "email" });
    const d = await t.verifyEmailLogin((await t.startEmailLogin("gus@example.com")).pendingId, GOOD_CODE);
    (t as any).sessions.clear();
    const r = await t.check(d.handle, []);
    expect(r.source).toBe("t3n-tee");
    expect(sent).toEqual(["gus@example.com"]); // no second email
  });

  it("email mode never mints anonymous identities", async () => {
    const t = make({ loginMethod: "email" });
    await expect(t.ensureIdentity("f".repeat(32))).rejects.toMatchObject({ name: "SignInRequired" });
    expect(await t.isSignedIn("f".repeat(32))).toBe(false);
  });
});

describe("RealT3n (self mode, anonymous login)", () => {
  it("new user: added to org + sponsored, then self-calls set-rules and check", async () => {
    const t = make();
    const h = "a".repeat(32);
    const { did, created } = await t.ensureIdentity(h);
    expect(created).toBe(true);
    expect(calls.map((c) => c.fn)).toEqual(["addOrganisationMember", "fundAgent"]);
    expect(calls[1].args).toEqual([did, 5_000_000]);
    await t.saveRules(h, { blockUnlimitedApprovals: true, blockApprovalForAll: true, maxSpendUsd: 1, maxLeverage: 1, allowlist: [], unlistedContract: "warn", permitSignatures: "warn", maxPermitDays: 1 });
    const r = await t.check(h, [{ kind: "approve", unlimited: true }]);
    expect(r).toMatchObject({ verdict: "block", source: "t3n-tee" });
    expect(calls.filter((c) => c.fn.startsWith("exec:")).map((c) => [c.fn, c.args[0]])).toEqual([["exec:set-rules", did], ["exec:check", did]]);
    expect(calls.some((c) => c.fn === "updateMemberDelegation")).toBe(false);
  });

  it("tops up once on InsufficientCredit, then respects the per-user cap", async () => {
    const t = make({ userCredits: 1, userCreditCap: 2 });
    const h = "b".repeat(32);
    const { did } = await t.ensureIdentity(h); // sponsored 1
    await t.check(h, []); // uses it
    await t.check(h, []); // insufficient -> top-up to cap 2 -> retry ok
    expect(calls.filter((c) => c.fn === "fundAgent")).toHaveLength(2);
    expect(calls.filter((c) => c.fn === "addOrganisationMember")).toHaveLength(1);
    await expect(t.check(h, [])).rejects.toThrow(/used its free T3N credits/);
    expect(balances[did]).toBe(0);
  });

  it("daily budget stops sponsorship", async () => {
    const t = make({ userCredits: 5, dailyBudget: 7 });
    await t.ensureIdentity("c".repeat(32));
    const second = await t.ensureIdentity("d".repeat(32)); // session still works…
    expect(second.created).toBe(true);
    await expect(t.check("d".repeat(32), [])).rejects.toThrow(/daily T3N credit budget/); // …but no free credits
  });

  it("explains T3N's 'non-user' refusal instead of failing the session", async () => {
    const t = make();
    const orig = (await import("@terminal3/t3n-sdk")).T3nClient.prototype as any;
    const add = orig.addOrganisationMember;
    orig.addOrganisationMember = async () => { throw new Error("RPC Error: input: user_did abc does not exist — can't attribute a non-user"); };
    try {
      const h = "e".repeat(32);
      const id = await t.ensureIdentity(h);
      expect(id.created).toBe(true);
      await expect(t.check(h, [])).rejects.toThrow(/registered\* users|registered/);
    } finally { orig.addOrganisationMember = add; }
  });

  it("self mode does not require saving rules before a check", () => {
    expect(make().requiresRulesBeforeCheck).toBe(false);
    expect(make({ userMode: "delegated", agentApiKey: "k", agentDid: "did:t3n:a" }).requiresRulesBeforeCheck).toBe(true);
  });

  it("refuses to start without an org in self mode", () => {
    expect(() => make({ orgDid: undefined })).toThrow(/T3N_ORG_DID/);
  });
});
