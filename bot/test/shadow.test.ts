import { test } from "node:test";
import assert from "node:assert/strict";
import type { Provider } from "ethers";
import { runShadowPass } from "../src/shadow.js";
import { loadConfig } from "../src/config.js";
import { createMetrics } from "../src/metrics/index.js";
import type { PayloadBundle, RyzeQuote } from "../src/types.js";
import type { FillTxInputs } from "../src/submitter/index.js";
import { dutchOrder, output, WETH, USDC } from "./fixtures.js";

const config = loadConfig("base");

const BASE_OUT = 1_000_000_000_000_000_000n; // 1 WETH owed (no decay ⇒ owed == startAmount)
const parsed = dutchOrder({ outputs: [output({ startAmount: BASE_OUT })] });

const bundle: PayloadBundle = {
  pythUpdateData: ["0xpyth"],
  cexPriceData: [],
  prices: [
    { token: USDC, priceWad: 1_000_000_000_000_000_000n },
    // $2000/WETH so the 0.1 WETH spread ≈ $200 clears the configured minProfitUsdWad floor ($0.10).
    { token: WETH, priceWad: 2_000_000_000_000_000_000_000n },
  ],
  fetchedAtMs: 0,
};

const quote: RyzeQuote = {
  path: [{ pool: "0xcccccccccccccccccccccccccccccccccccccccc", tokenIn: USDC, tokenOut: WETH }],
  amountIn: 1_000_000_000n,
  netAmountOut: 1_100_000_000_000_000_000n, // 1.1 WETH ⇒ 0.1 raw spread
  sessionizedSlippage: 0n,
  sessionizedWbf: 5n,
  wbrCredit: 0n,
};

const provider = {
  async getBlock() {
    return { baseFeePerGas: 1000n };
  },
} as unknown as Provider;

test("shadow pass quotes, bids, and builds (never sends) a fill for a profitable order", async () => {
  const submitted: FillTxInputs[] = [];
  let sendFlag: boolean | undefined;

  const results = await runShadowPass({
    config,
    provider,
    ingestor: { async poll() { return [{ orderHash: parsed.orderHash, encodedOrder: "0xabcd", signature: "0xsig" }]; } },
    payloads: {
      async getPayloads() { return bundle; },
      stats() { return { hits: 0, misses: 1, lastFetchAgeMs: 0 }; },
    },
    quoter: { async quoteExactIn() { return quote; } },
    submitter: {
      async submit(inputs, send) {
        submitted.push(inputs);
        sendFlag = send;
        return { tx: { to: config.addresses.executor }, sent: false };
      },
    },
    tokenMeta: { async decimalsOf(t) { return t.toLowerCase() === USDC.toLowerCase() ? 6 : 18; } },
    metrics: createMetrics(),
    parse: () => parsed,
    log: () => {},
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]!.inclusionPriorityFeeWei, BigInt(config.strategy.maxInclusionPriorityFeeWei));
  assert.ok(results[0]!.expectedProfitUsdWad > 0n);
  assert.equal(results[0]!.improving, false);

  // Built exactly one fill, in shadow mode (send falsey), with minAmountOut == what we owe the swapper.
  assert.equal(submitted.length, 1);
  assert.ok(!sendFlag);
  assert.equal(submitted[0]!.minAmountOut, BASE_OUT); // Dutch: owed is exactly the (no-decay) startAmount
  assert.equal(submitted[0]!.inclusionPriorityFeeWei, results[0]!.inclusionPriorityFeeWei);
  // Pyth fee is billed per non-empty update blob (the oracle bills one flat verification_fee per verifyUpdate
  // call). We send a single bundled blob, so the fee is exactly feePerToken × 1.
  const nonEmptyBlobs = bundle.pythUpdateData.filter((b) => b && b !== "0x").length;
  assert.equal(submitted[0]!.pythFeeWei, BigInt(config.oracle.pythVerificationFeeWei) * BigInt(nonEmptyBlobs));
});

test("shadow pass releases exposure for unsent (shadow) fills — no ratchet across passes", async () => {
  const { createExposureTracker } = await import("../src/strategy/risk.js");
  const exposure = createExposureTracker(2_000_000_000_000_000_000_000n); // $2k cap (order notional ≈ $1k)
  const deps = {
    config,
    provider,
    ingestor: { async poll() { return [{ orderHash: parsed.orderHash, encodedOrder: "0xabcd" as const, signature: "0xsig" as const }]; } },
    payloads: { async getPayloads() { return bundle; }, stats() { return { hits: 0, misses: 1, lastFetchAgeMs: 0 }; } },
    quoter: { async quoteExactIn() { return quote; } },
    submitter: { async submit() { return { tx: {}, sent: false }; } },
    tokenMeta: { async decimalsOf(t: string) { return t.toLowerCase() === USDC.toLowerCase() ? 6 : 18; } },
    metrics: createMetrics(),
    exposure,
    parse: () => ({ ...parsed, orderHash: `0x${Math.random().toString(16).slice(2)}` }),
    log: () => {},
  };
  // Several passes, each building one ~$1k fill: without the release, pass 3+ would skip exposure_over_cap.
  for (let i = 0; i < 5; i++) {
    const results = await runShadowPass(deps as never);
    assert.equal(results.length, 1, `pass ${i} must still bid`);
  }
  assert.equal(exposure.current(WETH), 0n, "exposure fully released after shadow passes");
});

test("shadow pass skips an unprofitable (no-spread) order without building a tx", async () => {
  let built = 0;
  const results = await runShadowPass({
    config,
    provider,
    ingestor: { async poll() { return [{ orderHash: "0xno", encodedOrder: "0x", signature: "0x" }]; } },
    payloads: { async getPayloads() { return bundle; }, stats() { return { hits: 0, misses: 1, lastFetchAgeMs: 0 }; } },
    quoter: { async quoteExactIn() { return { ...quote, netAmountOut: BASE_OUT }; } },
    submitter: {
      async submit() {
        built++;
        return { tx: {}, sent: false };
      },
    },
    tokenMeta: { async decimalsOf(t) { return t.toLowerCase() === USDC.toLowerCase() ? 6 : 18; } },
    metrics: createMetrics(),
    parse: () => parsed,
    log: () => {},
  });

  assert.equal(results.length, 0);
  assert.equal(built, 0);
});
