import { test } from "node:test";
import assert from "node:assert/strict";
import { decideBid, type BidContext } from "../src/strategy/index.js";
import type { Address, ParsedOrder, RyzeQuote } from "../src/types.js";

const A: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USDC: Address = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA";
const WETH: Address = "0x4200000000000000000000000000000000000006";

// Chosen so the arithmetic is exact: baseline 1e6, mpsPerWei 1, MPS 1e7 ⇒ +1 output per 10 wei of effective fee.
function order(over: Partial<ParsedOrder> = {}): ParsedOrder {
  return {
    orderHash: "0xorderhash",
    encodedOrder: "0x",
    signature: "0x",
    swapper: A,
    tokenIn: USDC,
    amountIn: 1_000_000_000n,
    inputMpsPerWei: 0n,
    outputs: [{ token: WETH, settlementToken: WETH, amount: 1_000_000n, mpsPerWei: 1n, recipient: A }],
    tokenOut: WETH,
    hasNativeOutput: false,
    multiToken: false,
    baselinePriorityFeeWei: 0n,
    auctionTargetBlock: 0,
    deadline: 0,
    ...over,
  };
}

function quote(over: Partial<RyzeQuote> = {}): RyzeQuote {
  return {
    path: [{ pool: A, tokenIn: USDC, tokenOut: WETH }],
    amountIn: 1_000_000_000n,
    netAmountOut: 1_000_100n, // rawSpread = 100 over baseline 1e6
    sessionizedSlippage: 0n,
    sessionizedWbf: 5n, // worsening by default
    wbrCredit: 0n,
    ...over,
  };
}

function ctx(over: Partial<BidContext> = {}): BidContext {
  return {
    priceOutWad: 1_000_000_000_000_000_000n, // $1 per full token
    decimalsOut: 0, // keep USD math trivial: usd = amount * price / 1
    nativePriceWad: 1_000_000_000_000_000_000n,
    gasEstimate: 100n,
    baseFeeWei: 0n,
    spreadCaptureBps: 6000,
    improvingShadeBps: 500,
    worseningShadeBps: 500,
    maxBidWei: 1_000_000_000n,
    minProfitUsdWad: 0n,
    maxNotionalUsdWad: 0n,
    notionalUsdWad: 0n,
    ...over,
  };
}

test("skips when there is no spread", () => {
  const r = decideBid(order(), quote({ netAmountOut: 1_000_000n }), ctx());
  assert.equal(r.kind, "skip");
});

test("skips when notional exceeds the cap", () => {
  const r = decideBid(order(), quote(), ctx({ maxNotionalUsdWad: 100n, notionalUsdWad: 101n }));
  assert.equal(r.kind, "skip");
});

test("base capture (shading disabled): keeps 60% of a 100-unit spread with an exact bid", () => {
  const r = decideBid(order(), quote(), ctx({ improvingShadeBps: 0, worseningShadeBps: 0 }));
  assert.equal(r.kind, "bid");
  if (r.kind !== "bid") return;
  assert.equal(r.decision.capturedSpreadOut, 60n); // capture 6000bps of 100
  assert.equal(r.decision.effectivePriorityFeeWei, 400n);
  assert.equal(r.decision.bidWei, 400n);
  assert.equal(r.decision.orderOwedOut, 1_000_040n);
  assert.equal(r.decision.improving, false);
});

test("improving flow shades capture down (bids higher, keeps less) vs worsening", () => {
  const improving = decideBid(order(), quote({ wbrCredit: 7n, sessionizedWbf: 0n }), ctx());
  const worsening = decideBid(order(), quote(), ctx());
  assert.equal(improving.kind, "bid");
  assert.equal(worsening.kind, "bid");
  if (improving.kind !== "bid" || worsening.kind !== "bid") return;
  assert.equal(improving.decision.improving, true);
  assert.equal(improving.decision.capturedSpreadOut, 55n); // 5500bps
  assert.equal(worsening.decision.capturedSpreadOut, 65n); // 6500bps
  assert.ok(improving.decision.bidWei > worsening.decision.bidWei);
});

test("gas is priced into profit and gates on min profit", () => {
  // captured 60 units * $1 = 60e18 wad gross. Set min profit above that ⇒ skip.
  const r = decideBid(order(), quote(), ctx({ minProfitUsdWad: 100_000_000_000_000_000_000n }));
  assert.equal(r.kind, "skip");
});

test("skips exact-output (input-scaling) orders", () => {
  const r = decideBid(order({ inputMpsPerWei: 1n }), quote(), ctx());
  assert.equal(r.kind, "skip");
  if (r.kind === "skip") assert.equal(r.reason, "input-scaling unsupported");
});

test("skips orders whose legs span multiple settlement tokens", () => {
  const r = decideBid(order({ multiToken: true }), quote(), ctx());
  assert.equal(r.kind, "skip");
  if (r.kind === "skip") assert.equal(r.reason, "multi-token outputs");
});

test("multi-output: owed and spread account for ALL legs (main + fee)", () => {
  // Two legs in WETH: main 1e6 + fee 2e5 = 1.2e6 baseline owed. rawSpread over 1.2e6 must use the sum.
  const twoLeg = order({
    outputs: [
      { token: WETH, settlementToken: WETH, amount: 1_000_000n, mpsPerWei: 1n, recipient: A },
      { token: WETH, settlementToken: WETH, amount: 200_000n, mpsPerWei: 0n, recipient: USDC },
    ],
  });
  // netOut 1_300_000 ⇒ rawSpread = 1_300_000 - 1_200_000 = 100_000. Capture 60% (shading off) ⇒ keep 60_000.
  const r = decideBid(twoLeg, quote({ netAmountOut: 1_300_000n }), ctx({ improvingShadeBps: 0, worseningShadeBps: 0 }));
  assert.equal(r.kind, "bid");
  if (r.kind !== "bid") return;
  assert.equal(r.decision.capturedSpreadOut, 60_000n);
  // orderOwedOut must exceed the summed baseline (1.2e6), proving both legs are covered.
  assert.ok(r.decision.orderOwedOut >= 1_200_000n);
  assert.equal(r.decision.orderOwedOut, 1_300_000n - 60_000n);
});
