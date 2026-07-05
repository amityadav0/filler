import { test } from "node:test";
import assert from "node:assert/strict";
import { decideBid, type BidContext } from "../src/strategy/index.js";
import type { Address, ParsedOrder, RyzeQuote } from "../src/types.js";

const A: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USDC: Address = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA";
const WETH: Address = "0x4200000000000000000000000000000000000006";

// Chosen so the arithmetic is exact: baseline 1e6, mpsPerWei 1, MPS 1e7 ⇒ +1 output per 10 wei of effective fee.
function order(): ParsedOrder {
  return {
    orderHash: "0xorderhash",
    encodedOrder: "0x",
    signature: "0x",
    swapper: A,
    tokenIn: USDC,
    amountIn: 1_000_000_000n,
    inputMpsPerWei: 0n,
    tokenOut: WETH,
    baselineAmountOut: 1_000_000n,
    outputMpsPerWei: 1n,
    outputRecipient: A,
    baselinePriorityFeeWei: 0n,
    auctionTargetBlock: 0,
    deadline: 0,
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
