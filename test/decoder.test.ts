import { describe, expect, it } from "vitest";
import { Interface, parseUnits } from "ethers";
import { decode, SELECTORS, MAX_UINT256 } from "../src/core/decoder";
import { evaluate, DEFAULT_RULES } from "../src/core/rules";
import { explain } from "../src/core/explain";
import { SAMPLES, DRAINER } from "../src/core/samples";

const erc20 = new Interface(["function approve(address,uint256)", "function transfer(address,uint256)", "function increaseAllowance(address,uint256)", "function setApprovalForAll(address,bool)"]);
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const sample = (id: string) => SAMPLES.find((s) => s.id === id)!.input;

describe("selectors", () => {
  it("are the canonical 4-byte ids", () => {
    expect(SELECTORS.approve).toBe("0x095ea7b3");
    expect(SELECTORS.transfer).toBe("0xa9059cbb");
    expect(SELECTORS.setApprovalForAll).toBe("0xa22cb465");
    expect(SELECTORS.permit).toBe("0xd505accf");
    expect(SELECTORS.increaseAllowance).toBe("0x39509351");
    expect(SELECTORS.permit2Approve).toBe("0x87517c45");
  });
});

describe("HOSTILE DEMO: unlimited USDC approve", () => {
  const r = decode(sample("unlimited-usdc"));
  it("decodes as unlimited USDC approve to an unknown spender on Arbitrum", () => {
    expect(r.source).toBe("tx");
    expect(r.facts).toHaveLength(1);
    const f = r.facts[0];
    expect(f.kind).toBe("approve");
    expect(f.chainId).toBe(42161);
    expect(f.tokenSymbol).toBe("USDC");
    expect(f.unlimited).toBe(true);
    expect(f.amountRaw).toBe(MAX_UINT256.toString());
    expect(f.spender?.toLowerCase()).toBe(DRAINER);
    expect(f.spenderKnown).toBe(false);
  });
  it("is BLOCKED with a plain-English 'don't sign'", () => {
    const p = evaluate(r.facts, DEFAULT_RULES);
    expect(p.verdict).toBe("block");
    expect(p.hits[0].code).toBe("unlimited_approval");
    const e = explain(r.facts, p);
    expect(e.headline).toBe("Don't sign. This wants unlimited USDC spend.");
    expect(e.why.join(" ")).toMatch(/drain every USDC/);
  });
  it("same result from bare calldata + chain hint", () => {
    const data = erc20.encodeFunctionData("approve", [DRAINER, MAX_UINT256]);
    const r2 = decode(data, { to: USDC_ARB, chainId: 42161 });
    expect(r2.source).toBe("calldata");
    expect(evaluate(r2.facts, DEFAULT_RULES).verdict).toBe("block");
  });
  it("bare calldata with no token context still blocks (unlimited is unlimited)", () => {
    const r3 = decode(erc20.encodeFunctionData("approve", [DRAINER, MAX_UINT256]));
    expect(r3.facts[0].unlimited).toBe(true);
    expect(evaluate(r3.facts, DEFAULT_RULES).verdict).toBe("block");
  });
});

describe("ERC-20 decoding", () => {
  it("exact approve prices stablecoins", () => {
    const r = decode(JSON.stringify({ chainId: 42161, to: USDC_ARB, data: erc20.encodeFunctionData("approve", [DRAINER, parseUnits("250", 6)]) }));
    expect(r.facts[0].amount).toBe(250);
    expect(r.facts[0].amountUsd).toBe(250);
    expect(r.facts[0].unlimited).toBe(false);
  });
  it("increaseAllowance", () => {
    const r = decode(erc20.encodeFunctionData("increaseAllowance", [DRAINER, MAX_UINT256]), { to: USDC_ARB, chainId: 42161 });
    expect(r.facts[0].kind).toBe("increaseAllowance");
    expect(r.facts[0].unlimited).toBe(true);
  });
  it("transfer", () => {
    const r = decode(erc20.encodeFunctionData("transfer", [DRAINER, parseUnits("10", 6)]), { to: USDC_ARB, chainId: 42161 });
    expect(r.facts[0]).toMatchObject({ kind: "transfer", amount: 10, amountUsd: 10 });
    expect(evaluate(r.facts, DEFAULT_RULES).verdict).toBe("allow");
  });
  it("huge-but-finite amount of a known token counts as unlimited", () => {
    const r = decode(erc20.encodeFunctionData("approve", [DRAINER, parseUnits("5000000000000", 6)]), { to: USDC_ARB, chainId: 42161 });
    expect(r.facts[0].unlimited).toBe(true);
  });
  it("accepts `input` instead of `data` and JSON-RPC eth_sendTransaction wrapper", () => {
    const tx = { to: USDC_ARB, input: erc20.encodeFunctionData("approve", [DRAINER, MAX_UINT256]), chainId: "0xa4b1" };
    const r = decode(JSON.stringify({ method: "eth_sendTransaction", params: [tx] }));
    expect(r.facts[0]).toMatchObject({ kind: "approve", chainId: 42161, tokenSymbol: "USDC", unlimited: true });
  });
  it("native transfer with ETH price", () => {
    const r = decode(JSON.stringify({ chainId: 1, to: DRAINER, value: "2000000000000000000", data: "0x" }), { prices: { ETH: 3000 } });
    expect(r.facts[0]).toMatchObject({ kind: "native_transfer", amount: 2, amountUsd: 6000 });
    expect(evaluate(r.facts, DEFAULT_RULES).verdict).toBe("block");
  });
});

describe("prediction-market + perps", () => {
  it("Polymarket setApprovalForAll to unknown operator blocks", () => {
    const r = decode(sample("polymarket-operator"));
    expect(r.facts[0]).toMatchObject({ kind: "setApprovalForAll", approvalForAll: true, targetLabel: "Polymarket Conditional Tokens" });
    expect(evaluate(r.facts, DEFAULT_RULES).verdict).toBe("block");
  });
  it("Polymarket setApprovalForAll to the real CTF Exchange is fine when allowlisted", () => {
    const data = erc20.encodeFunctionData("setApprovalForAll", ["0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E", true]);
    const r = decode(data, { to: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045", chainId: 137 });
    expect(r.facts[0].spenderLabel).toBe("Polymarket CTF Exchange");
    const p = evaluate(r.facts, { ...DEFAULT_RULES, allowlist: ["0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e"] });
    expect(p.verdict).toBe("warn"); // still flagged, but not blocked
  });
  it("Hyperliquid 50x leverage blocks", () => {
    const r = decode(sample("hl-50x"));
    expect(r.source).toBe("hyperliquid");
    expect(r.facts[0]).toMatchObject({ kind: "perp_leverage", leverage: 50 });
    const p = evaluate(r.facts, DEFAULT_RULES);
    expect(p.verdict).toBe("block");
    expect(explain(r.facts, p).headline).toMatch(/50x/);
  });
  it("GMX v1 increase position: 10k on 400 USDC = 25x", () => {
    const r = decode(sample("gmx-25x"));
    expect(r.facts[0]).toMatchObject({ kind: "perp_open", protocol: "GMX", sizeUsd: 10000, leverage: 25, amountUsd: 400 });
    expect(evaluate(r.facts, DEFAULT_RULES).hits.map((h) => h.code)).toContain("leverage_over_cap");
  });
});

describe("typed data", () => {
  it("EIP-2612 Permit drain via eth_signTypedData_v4", () => {
    const r = decode(sample("permit-drain"));
    expect(r.source).toBe("typed_data");
    expect(r.facts[0]).toMatchObject({ kind: "permit", offchainSignature: true, tokenSymbol: "USDC", unlimited: true, chainId: 1 });
    const p = evaluate(r.facts, DEFAULT_RULES);
    expect(p.verdict).toBe("block");
    expect(p.hits.map((h) => h.code)).toEqual(expect.arrayContaining(["unlimited_approval", "permit_signature"]));
  });
  it("Permit2 PermitBatch → one fact per token", () => {
    const td = {
      primaryType: "PermitBatch",
      domain: { name: "Permit2", chainId: 1, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
      message: {
        details: [
          { token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", amount: "1461501637330902918203684832716283019655932542975", expiration: "4102444800", nonce: 0 },
          { token: "0xdAC17F958D2ee523a2206206994597C13D831ec7", amount: "5000000", expiration: "1795086400", nonce: 0 },
        ],
        spender: DRAINER,
        sigDeadline: "1795086400",
      },
      types: {},
    };
    const r = decode(JSON.stringify(td));
    expect(r.facts).toHaveLength(2);
    expect(r.facts[0]).toMatchObject({ kind: "permit2", tokenSymbol: "USDC", unlimited: true });
    expect(r.facts[1]).toMatchObject({ kind: "permit2", tokenSymbol: "USDT", amount: 5, unlimited: false });
    expect(evaluate(r.facts, DEFAULT_RULES).verdict).toBe("block");
  });
  it("Polymarket BUY order over cap", () => {
    const td = { primaryType: "Order", domain: { name: "Polymarket CTF Exchange", chainId: 137, verifyingContract: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" }, message: { side: 0, makerAmount: "2500000000", takerAmount: "5000000000" }, types: {} };
    const r = decode(JSON.stringify(td));
    expect(r.facts[0]).toMatchObject({ protocol: "Polymarket", amountUsd: 2500 });
    expect(evaluate(r.facts, DEFAULT_RULES).verdict).toBe("block");
  });
  it("unknown typed data warns", () => {
    const r = decode(JSON.stringify({ primaryType: "Mystery", domain: {}, message: { a: 1 }, types: {} }));
    expect(evaluate(r.facts, DEFAULT_RULES).verdict).toBe("warn");
  });
});

describe("wallet text + misc", () => {
  it("MetaMask-style 'spending cap: unlimited USDC' text blocks", () => {
    const r = decode(`Spending cap request\nGrant permission to spend: Unlimited USDC\nSpender: ${DRAINER}`);
    expect(r.source).toBe("text");
    expect(r.facts[0]).toMatchObject({ kind: "approve", unlimited: true, tokenSymbol: "USDC" });
    expect(evaluate(r.facts, DEFAULT_RULES).verdict).toBe("block");
  });
  it("leverage text", () => {
    const r = decode("Open long BTC 40x, size $20,000");
    expect(r.facts[0]).toMatchObject({ leverage: 40, sizeUsd: 20000 });
    expect(evaluate(r.facts, DEFAULT_RULES).verdict).toBe("block");
  });
  it("tx hash is detected for server-side lookup", () => {
    const h = "0x" + "ab".repeat(32);
    expect(decode(h)).toMatchObject({ source: "hash", hash: h });
  });
  it("garbage → unknown → warn, never allow", () => {
    const r = decode("lol hi");
    expect(evaluate(r.facts, DEFAULT_RULES).verdict).toBe("warn");
  });
  it("unknown selector on unknown contract warns", () => {
    const r = decode("0xdeadbeef" + "00".repeat(64), { to: DRAINER });
    expect(r.facts[0].kind).toBe("unknown");
    expect(evaluate(r.facts, DEFAULT_RULES).verdict).toBe("warn");
  });
  it("safe sample passes", () => {
    const r = decode(sample("safe-approve"));
    expect(r.facts[0]).toMatchObject({ spenderLabel: "Uniswap Permit2", amount: 50 });
    expect(evaluate(r.facts, DEFAULT_RULES).verdict).toBe("allow");
  });
  it("every scary sample is not allowed; every safe sample is allowed", () => {
    for (const s of SAMPLES) {
      const v = evaluate(decode(s.input).facts, DEFAULT_RULES).verdict;
      if (s.scary) expect(v, s.id).not.toBe("allow");
      else expect(v, s.id).toBe("allow");
    }
  });
});
