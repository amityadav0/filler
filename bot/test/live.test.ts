import { test } from "node:test";
import assert from "node:assert/strict";
import type { Provider } from "ethers";
import { runLivePass, type LiveDeps } from "../src/live.js";
import { loadConfig } from "../src/config.js";
import { createMetrics } from "../src/metrics/index.js";
import { createExposureTracker, createGasBudget } from "../src/strategy/risk.js";
import type { ParsedOrder, PayloadBundle, RyzeQuote } from "../src/types.js";
import type { FillTxInputs } from "../src/submitter/index.js";
import { dutchOrder, output, OTHER, WETH, USDC } from "./fixtures.js";

const config = loadConfig("base");

const BASE_OUT = 1_000_000_000_000_000_000n; // 1 WETH owed (no decay ⇒ owed == startAmount)
const NOW = 1_700_000_000_000; // fixed clock (ms)
const CURRENT_BLOCK = 1_000;

const parsed: ParsedOrder = dutchOrder({
  outputs: [output({ startAmount: BASE_OUT })],
  deadline: Math.floor(NOW / 1000) + 60,
});

const bundle: PayloadBundle = {
  pythUpdateData: ["0xpyth"],
  cexPriceData: [],
  prices: [
    { token: USDC, priceWad: 1_000_000_000_000_000_000n },
    { token: WETH, priceWad: 2_000_000_000_000_000_000_000n }, // $2000 → ~0.1 WETH spread ≈ $200
  ],
  fetchedAtMs: 0,
};

const quote: RyzeQuote = {
  path: [{ pool: "0xcccccccccccccccccccccccccccccccccccccccc", tokenIn: USDC, tokenOut: WETH }],
  amountIn: 1_000_000_000n,
  netAmountOut: 1_100_000_000_000_000_000n, // 1.1 WETH ⇒ 0.1 spread
  sessionizedSlippage: 0n,
  sessionizedWbf: 5n,
  wbrCredit: 0n,
};

interface Overrides {
  order?: Partial<ParsedOrder>;
  requote?: RyzeQuote | null;
  receipt?: { status: number; gasUsed: bigint; gasPrice: bigint } | null;
  gasBudget?: ReturnType<typeof createGasBudget>;
  exposure?: ReturnType<typeof createExposureTracker>;
}

function makeDeps(o: Overrides = {}) {
  const sent: FillTxInputs[] = [];
  const waits: number[] = [];
  const p = { ...parsed, ...o.order };
  let curBlock = CURRENT_BLOCK;
  let quoteCalls = 0;
  const deps: LiveDeps = {
    config,
    provider: { async getBlock() { return { baseFeePerGas: 1000n }; } } as unknown as Provider,
    ingestor: { async poll() { return [{ orderHash: p.orderHash, encodedOrder: "0xabcd" as const, signature: "0xsig" as const }]; } },
    payloads: { async getPayloads() { return bundle; }, stats() { return { hits: 0, misses: 1, lastFetchAgeMs: 0 }; } },
    quoter: {
      async quoteExactIn() {
        quoteCalls++;
        // First call = prepare-time quote; later calls = the send-time re-quote.
        if (quoteCalls > 1 && o.requote !== undefined) return o.requote;
        return quote;
      },
    },
    submitter: {
      async submit(inputs, send) {
        assert.equal(send, true, "live pass must request a real send");
        sent.push(inputs);
        return { tx: {}, sent: true, txHash: "0xf1110000" as const };
      },
    },
    tokenMeta: { async decimalsOf(t: string) { return t.toLowerCase() === USDC.toLowerCase() ? 6 : 18; } },
    metrics: createMetrics(),
    exposure: o.exposure ?? createExposureTracker(0n),
    gasBudget: o.gasBudget ?? createGasBudget(0n, () => NOW),
    parse: () => p,
    log: () => {},
    now: () => NOW,
    currentBlock: async () => curBlock,
    // Waiting advances the mock chain, so evaluation after a decay-wait sees the reached block.
    waitForBlock: async (n: number) => { waits.push(n); curBlock = Math.max(curBlock, n); },
    waitForReceipt: async () => (o.receipt !== undefined ? o.receipt : { status: 1, gasUsed: 1_000_000n, gasPrice: 2000n }),
  };
  return { deps, sent, waits };
}

test("live pass sends a winning fill (minAmountOut = owed) and reports won", async () => {
  const { deps, sent } = makeDeps();
  const results = await runLivePass(deps);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.won, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.minAmountOut, BASE_OUT); // Dutch: exactly the resolved owed
});

test("waits past the exclusivity window (decayStartBlock) before filling a foreign-exclusive order", async () => {
  const decayStartBlock = CURRENT_BLOCK + 5;
  const { deps, sent, waits } = makeDeps({ order: { decayStartBlock, exclusiveFiller: OTHER, exclusivityOverrideBps: 25 } });
  await runLivePass(deps);
  assert.deepEqual(waits, [decayStartBlock + 1]); // wait until just past the window (handicap drops)
  assert.equal(sent.length, 1);
});

test("skips when the exclusivity window ends too many blocks ahead", async () => {
  const decayStartBlock = CURRENT_BLOCK + config.live.maxDecayWaitBlocks + 1;
  const { deps, sent } = makeDeps({ order: { decayStartBlock, exclusiveFiller: OTHER, exclusivityOverrideBps: 25 } });
  const results = await runLivePass(deps);
  assert.equal(results.length, 0);
  assert.equal(sent.length, 0);
});

test("skips orders whose deadline is too close", async () => {
  const { deps, sent } = makeDeps({ order: { deadline: Math.floor(NOW / 1000) + 1 } });
  assert.equal((await runLivePass(deps)).length, 0);
  assert.equal(sent.length, 0);
});

test("lost fill consumes the reverted-gas budget; exhausted budget blocks the next attempt", async () => {
  // Worst-case pre-send estimate = (baseFee 1000 + inclusionTip 1e9) × gasEstimate 1.3M = 1_300_001_300_000_000.
  const worstCase = (1000n + BigInt(config.strategy.maxInclusionPriorityFeeWei)) * BigInt(config.strategy.gasEstimate);
  const gasBudget = createGasBudget(worstCase, () => NOW);
  const lost = { status: 0, gasUsed: 1_000_000n, gasPrice: 2_500n }; // 2.5e9 wei spent
  const first = makeDeps({ receipt: lost, gasBudget });
  const r1 = await runLivePass(first.deps);
  assert.equal(r1[0]!.won, false);
  assert.equal(gasBudget.spentLastHour(), 2_500_000_000n);

  const second = makeDeps({ receipt: lost, gasBudget });
  const r2 = await runLivePass(second.deps);
  assert.equal(r2.length, 0, "second attempt must be blocked by the gas budget");
  assert.equal(second.sent.length, 0);
});

test("send-time re-quote below owed aborts the send", async () => {
  const { deps, sent } = makeDeps({ requote: { ...quote, netAmountOut: BASE_OUT - 1n } });
  assert.equal((await runLivePass(deps)).length, 0);
  assert.equal(sent.length, 0);
});

test("exposure is held during flight and released after the receipt, win or lose", async () => {
  for (const receipt of [{ status: 1, gasUsed: 1n, gasPrice: 1n }, { status: 0, gasUsed: 1n, gasPrice: 1n }]) {
    const exposure = createExposureTracker(10_000_000_000_000_000_000_000n);
    const { deps } = makeDeps({ receipt, exposure });
    await runLivePass(deps);
    assert.equal(exposure.current(WETH), 0n, "exposure released after receipt");
  }
});
