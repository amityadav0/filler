import { test } from "node:test";
import assert from "node:assert/strict";
import { decideFill, type FillContext } from "../src/strategy/index.js";
import { dutchOrder, output, A, OTHER, USDC, WETH } from "./fixtures.js";
import type { RyzeQuote } from "../src/types.js";

function quote(over: Partial<RyzeQuote> = {}): RyzeQuote {
  return {
    path: [{ pool: A, tokenIn: USDC, tokenOut: WETH }],
    amountIn: 1_000_000_000n,
    netAmountOut: 1_000_100n, // spread = 100 over owed 1e6
    sessionizedSlippage: 0n,
    sessionizedWbf: 5n, // worsening by default
    wbrCredit: 0n,
    ...over,
  };
}

function ctx(over: Partial<FillContext> = {}): FillContext {
  return {
    filler: A, // our executor; not the exclusive filler in the exclusivity tests (they use OTHER)
    priceOutWad: 1_000_000_000_000_000_000n, // $1 per full token
    decimalsOut: 0, // usd = amount * price / 1
    nativePriceWad: 1_000_000_000_000_000_000n,
    gasEstimate: 100n,
    baseFeeWei: 0n,
    inclusionPriorityFeeWei: 0n,
    minProfitUsdWad: 0n,
    maxNotionalUsdWad: 0n,
    notionalUsdWad: 0n,
    ...over,
  };
}

const BLOCK = 500;

test("skips when there is no spread", () => {
  const r = decideFill(dutchOrder(), quote({ netAmountOut: 1_000_000n }), ctx(), BLOCK);
  assert.equal(r.kind, "skip");
  if (r.kind === "skip") assert.equal(r.reason, "no spread");
});

test("skips when notional exceeds the cap", () => {
  const r = decideFill(dutchOrder(), quote(), ctx({ maxNotionalUsdWad: 100n, notionalUsdWad: 101n }), BLOCK);
  assert.equal(r.kind, "skip");
  if (r.kind === "skip") assert.equal(r.reason, "notional over cap");
});

test("fills a profitable order: keeps the WHOLE spread and sets minAmountOut = owed", () => {
  const r = decideFill(dutchOrder(), quote(), ctx(), BLOCK);
  assert.equal(r.kind, "fill");
  if (r.kind !== "fill") return;
  assert.equal(r.decision.orderOwedOut, 1_000_000n); // decayed owed (no decay ⇒ startAmount)
  assert.equal(r.decision.capturedSpreadOut, 100n); // full spread — no swapper-offer term
  assert.equal(r.decision.expectedProfitUsdWad, 100n * 10n ** 18n);
  assert.equal(r.decision.improving, false);
});

test("gas is priced into profit and gates on the min-profit floor", () => {
  // spread 100 × $1 = 1e20 wad; require strictly more than that ⇒ skip.
  const r = decideFill(dutchOrder(), quote(), ctx({ minProfitUsdWad: 200_000_000_000_000_000_000n }), BLOCK);
  assert.equal(r.kind, "skip");
  if (r.kind === "skip") assert.equal(r.reason, "below min profit");
});

test("skips orders whose legs span multiple settlement tokens", () => {
  const r = decideFill(dutchOrder({ multiToken: true }), quote(), ctx(), BLOCK);
  assert.equal(r.kind, "skip");
  if (r.kind === "skip") assert.equal(r.reason, "multi-token outputs");
});

test("multi-output: owed and spread account for ALL legs", () => {
  const twoLeg = dutchOrder({
    outputs: [output({ startAmount: 1_000_000n }), output({ startAmount: 200_000n, recipient: USDC })],
  });
  const r = decideFill(twoLeg, quote({ netAmountOut: 1_300_000n }), ctx(), BLOCK);
  assert.equal(r.kind, "fill");
  if (r.kind !== "fill") return;
  assert.equal(r.decision.orderOwedOut, 1_200_000n); // 1e6 + 2e5 summed
  assert.equal(r.decision.capturedSpreadOut, 100_000n); // 1.3e6 - 1.2e6
});

test("strict exclusivity in-window is skipped for us (a foreign filler)", () => {
  const order = dutchOrder({ decayStartBlock: BLOCK + 10, exclusiveFiller: OTHER, exclusivityOverrideBps: 0 });
  const r = decideFill(order, quote(), ctx(), BLOCK);
  assert.equal(r.kind, "skip");
  if (r.kind === "skip") assert.equal(r.reason, "strict exclusivity");
});

test("exclusivity override handicap shrinks our spread and can flip a fill to a skip", () => {
  // owed 1e6, override 25bps ⇒ we owe ceil(1e6*10025/10000)=1_002_500. Spread quote must beat that.
  const order = dutchOrder({ decayStartBlock: BLOCK + 10, exclusiveFiller: OTHER, exclusivityOverrideBps: 25 });
  const thin = decideFill(order, quote({ netAmountOut: 1_001_000n }), ctx(), BLOCK); // below handicapped owed
  assert.equal(thin.kind, "skip");
  const fat = decideFill(order, quote({ netAmountOut: 1_003_000n }), ctx(), BLOCK); // clears handicap
  assert.equal(fat.kind, "fill");
  if (fat.kind === "fill") assert.equal(fat.decision.orderOwedOut, 1_002_500n);
});
