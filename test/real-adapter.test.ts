/** RealT3n with the SDK mocked: checks call names, sponsorship and caps (no network). */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const calls: { fn: string; args: unknown[] }[] = [];
let balances: Record<string, number> = {};
let nextDid = 0;

vi.mock("@terminal3/t3n-sdk", () => {
  class T3nClient {
    did = "";
    constructor(public cfg: any) {}
    async handshake() {}
    async authenticate() { this.did = `did:t3n:${(++nextDid).toString(16).padStart(40, "0")}`; return { value: this.did }; }
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
    getContractVersion: async () => "0.1.0",
    fanOutGrant: (g: any, fns: string[]) => fns.map((f) => ({ ...g, function: f })),
    invoke: async () => ({ verdict: "allow", codes: [] }),
    InvokeError: class extends Error {},
  };
});

const { RealT3n } = await import("../src/server/t3n/real");
const DEV = "0x" + "11".repeat(32);
const make = (over: Partial<ConstructorParameters<typeof RealT3n>[0]> = {}) =>
  new RealT3n({ env: "testnet", devKey: DEV, orgDid: "did:t3n:org", userMode: "self", userCredits: 5, userCreditCap: 10, dailyBudget: 1000, contract: "z:abc:signguard", keySecret: "s".repeat(32), dataDir: mkdtempSync(join(tmpdir(), "sgr-")), ...over });

beforeEach(() => { calls.length = 0; balances = {}; });

describe("RealT3n (self mode)", () => {
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
