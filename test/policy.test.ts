import { describe, expect, it } from "vitest";
import vectors from "../test-vectors/policy.json";
import { evaluate, normalizeRules, DEFAULT_RULES } from "../src/core/rules";
import type { TxFacts } from "../src/core/types";

describe("policy test vectors (shared with the Rust TEE contract)", () => {
  it("default rules in vectors match DEFAULT_RULES", () => {
    expect(vectors.defaultRules).toEqual(DEFAULT_RULES);
  });
  for (const c of vectors.cases) {
    it(c.name, () => {
      const rules = normalizeRules({ ...vectors.defaultRules, ...(c as any).rules } as any);
      const r = evaluate(c.facts as TxFacts[], rules, vectors.now);
      expect(r.verdict).toBe(c.expect.verdict);
      expect(r.hits.map((h) => h.code).sort()).toEqual([...c.expect.codes].sort());
    });
  }
});

describe("normalizeRules", () => {
  it("lowercases + dedupes allowlist, accepts comma strings", () => {
    const r = normalizeRules({ allowlist: "0x000000000022D473030F116dDEE9F6B43aC78BA3, 0x000000000022d473030f116ddee9f6b43ac78ba3" as any });
    expect(r.allowlist).toEqual(["0x000000000022d473030f116ddee9f6b43ac78ba3"]);
  });
  it("rejects junk", () => {
    expect(() => normalizeRules({ allowlist: ["not-an-address"] })).toThrow();
    expect(() => normalizeRules({ maxLeverage: -2 })).toThrow();
    expect(() => normalizeRules({ permitSignatures: "maybe" as any })).toThrow();
  });
  it("empty string disables a cap", () => {
    expect(normalizeRules({ maxSpendUsd: "" as any }).maxSpendUsd).toBeNull();
  });
});
