/** One-click demo inputs. All addresses marked "drainer" are made up. */
import { Interface, parseUnits } from "ethers";

const erc20 = new Interface([
  "function approve(address,uint256)",
  "function setApprovalForAll(address,bool)",
]);
const gmx = new Interface([
  "function createIncreasePosition(address[] _path, address _indexToken, uint256 _amountIn, uint256 _minOut, uint256 _sizeDelta, bool _isLong, uint256 _acceptablePrice, uint256 _executionFee, bytes32 _referralCode, address _callbackTarget)",
]);
const MAX = (1n << 256n) - 1n;
export const DRAINER = "0x3c1e5f0a9b7d42e8a6c0f19d2b4e7a8c5d6f0e91";

export interface Sample {
  id: string;
  title: string;
  blurb: string;
  scary: boolean;
  input: string;
}

const j = (o: unknown) => JSON.stringify(o, null, 2);

export const SAMPLES: Sample[] = [
  {
    id: "unlimited-usdc",
    title: "“Claim your airdrop” — unlimited USDC approve",
    blurb: "A fake airdrop site asks you to approve USDC. The amount is 2²⁵⁶−1.",
    scary: true,
    input: j({
      chainId: 42161,
      to: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      value: "0x0",
      data: erc20.encodeFunctionData("approve", [DRAINER, MAX]),
    }),
  },
  {
    id: "permit-drain",
    title: "Gasless “verify wallet” signature (Permit)",
    blurb: "No gas, no tx — just a signature. It's a USDC permit for everything.",
    scary: true,
    input: j({
      method: "eth_signTypedData_v4",
      params: [
        "0x1111111111111111111111111111111111111111",
        {
          types: {
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "version", type: "string" },
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
            Permit: [
              { name: "owner", type: "address" },
              { name: "spender", type: "address" },
              { name: "value", type: "uint256" },
              { name: "nonce", type: "uint256" },
              { name: "deadline", type: "uint256" },
            ],
          },
          primaryType: "Permit",
          domain: { name: "USD Coin", version: "2", chainId: 1, verifyingContract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
          message: { owner: "0x1111111111111111111111111111111111111111", spender: DRAINER, value: MAX.toString(), nonce: 0, deadline: "4102444800" },
        },
      ],
    }),
  },
  {
    id: "polymarket-operator",
    title: "Fake Polymarket “claim winnings” — setApprovalForAll",
    blurb: "Hands an unknown operator every outcome share you hold.",
    scary: true,
    input: j({ chainId: 137, to: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045", data: erc20.encodeFunctionData("setApprovalForAll", [DRAINER, true]) }),
  },
  {
    id: "hl-50x",
    title: "Hyperliquid — set 50x leverage",
    blurb: "Degen hour. Your rule says max 10x.",
    scary: true,
    input: j({ action: { type: "updateLeverage", asset: 0, isCross: true, leverage: 50 } }),
  },
  {
    id: "gmx-25x",
    title: "GMX — 25x ETH long with 400 USDC",
    blurb: "$10k position on $400 collateral.",
    scary: true,
    input: j({
      chainId: 42161,
      to: "0xb87a436B93fFE9D75c5cFA7bAcFff96430b09868",
      value: "180000000000000",
      data: gmx.encodeFunctionData("createIncreasePosition", [
        ["0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"],
        "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        parseUnits("400", 6),
        0n,
        parseUnits("10000", 30),
        true,
        parseUnits("3500", 30),
        180000000000000n,
        "0x" + "00".repeat(32),
        "0x0000000000000000000000000000000000000000",
      ]),
    }),
  },
  {
    id: "safe-approve",
    title: "Normal swap — approve 50 USDC to Uniswap Permit2",
    blurb: "Exact amount, known protocol. This one should pass.",
    scary: false,
    input: j({ chainId: 8453, to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", data: erc20.encodeFunctionData("approve", ["0x000000000022D473030F116dDEE9F6B43aC78BA3", parseUnits("50", 6)]) }),
  },
];
