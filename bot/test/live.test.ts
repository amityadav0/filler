import { test } from "node:test";
import assert from "node:assert/strict";
import type { Provider } from "ethers";
import { runLivePass, type LiveDeps } from "../src/live.js";
import { loadConfig } from "../src/config.js";
import { createMetrics } from "../src/metrics/index.js";
import { createExposureTracker, createGasBudget } from "../src/strategy/risk.js";
import type { Address, ParsedOrder, PayloadBundle, RyzeQuote } from "../src/types.js";
import type { FillTxInputs } from "../src/submitter/index.js";

const config = loadConfig("base");
const WETH = config.addresses.weth;
const USDC: Address = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA";

const BASE_OUT = 1_000_000_000_000_000_000n; // 1 WETH baseline owed
const NOW = 1_700_000_000_000; // fixed clock (ms)
const CURRENT_BLOCK = 1_000;

const parsed: ParsedOrder = {
  orderHash: "0xorderhash0000",
  encodedOrder: "0xabcd",
  signature: "0xsig",
  swapper: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  tokenIn: USDC,
  amountIn: 1_000_000_000n,
  inputMpsPerWei: 0n,
  outputs: [
    { token: WETH, settlementToken: WETH, amount: BASE_OUT, mpsPerWei: 1n, recipient: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  ],
  tokenOut: WETH,
  hasNativeOutput: false,
  multiToken: false,
  baselinePriorityFeeWei: 0n,
  auctionTargetBlock: CURRENT_BLOCK, // fillable now unless a test overrides
  deadline: Math.floor(NOW / 1000) + 60,
};

const bundle: PayloadBundle = {
  pythUpdateData: ["0xpyth"],
  cexPriceData: [],
  prices: [
    { token: USDC, priceWad: 1_000_000_000_000_000_000n },
    { token: WETH, priceWad: 2_000_000_000_000_000_000_000n }, // $2000 → ~0.1 WETH spread ≈ $200 (clears $0.10 floor)
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
    currentBlock: async () => CURRENT_BLOCK,
    waitForBlock: async (n: number) => { waits.push(n); },
    waitForReceipt: async () => (o.receipt !== undefined ? o.receipt : { status: 1, gasUsed: 1_000_000n, gasPrice: 2000n }),
  };
  return { deps, sent, waits };
}

test("live pass sends a winning fill and reports won", async () => {
  const { deps, sent } = makeDeps();
  const results = await runLivePass(deps);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.won, true);
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.minAmountOut > BASE_OUT);
});

test("waits for auctionTargetBlock (minus send lead) before sending", async () => {
  const target = CURRENT_BLOCK + 5;
  const { deps, sent, waits } = makeDeps({ order: { auctionTargetBlock: target } });
  await runLivePass(deps);
  assert.deepEqual(waits, [target - config.live.sendLeadBlocks]);
  assert.equal(sent.length, 1);
});

test("skips orders whose target block is too far ahead", async () => {
  const { deps, sent } = makeDeps({
    order: { auctionTargetBlock: CURRENT_BLOCK + config.live.maxTargetBlockLeadBlocks + 1 },
  });
  const results = await runLivePass(deps);
  assert.equal(results.length, 0);
  assert.equal(sent.length, 0);
});

test("skips orders whose deadline is too close", async () => {
  const { deps, sent } = makeDeps({ order: { deadline: Math.floor(NOW / 1000) + 1 } });
  assert.equal((await runLivePass(deps)).length, 0);
  assert.equal(sent.length, 0);
});

test("lost auction consumes the reverted-gas budget; exhausted budget blocks the next attempt", async () => {
  // Worst-case pre-send estimate = (baseFee 1000 + bid 350000) × gasEstimate 1.3M = 4.563e11 wei
  // (bid: 35% of the 0.1 WETH spread offered at capture 60% + worsening shade 5%, weight 1e18 → 350k wei).
  // Budget admits one attempt; after recording the 2.5e9 actual loss, a second attempt no longer fits.
  const gasBudget = createGasBudget(457_000_000_000n, () => NOW);
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
  const { deps, sent } = makeDeps({ requote: { ...quote, netAmountOut: BASE_OUT } });
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
