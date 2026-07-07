// shadow loop (M3): poll live Base orders → quote through Ryze → choose a priority-fee bid → BUILD the fill tx
// (never send) → log would-be P&L. This is the full filler loop minus broadcasting; run it for a week and review
// the shadow P&L logs before going live (M4).
import type { Provider } from "ethers";
import type { Ingestor } from "./ingestor/index.js";
import { parsePriorityOrder } from "./ingestor/index.js";
import type { PayloadService } from "./payloads/index.js";
import type { Quoter } from "./quoter/index.js";
import type { Metrics } from "./metrics/index.js";
import type { Submitter } from "./submitter/index.js";
import type { TokenMeta } from "./chain/tokens.js";
import type { OpenOrder } from "./ingestor/index.js";
import { decideBid, type BidContext } from "./strategy/index.js";
import { usdWad } from "./strategy/economics.js";
import { createExposureTracker, type ExposureTracker } from "./strategy/risk.js";
import type { Address, ParsedOrder } from "./types.js";
import { allPoolAssets, type FillerConfig } from "./config.js";

export interface ShadowDeps {
  config: FillerConfig;
  provider: Provider;
  ingestor: Ingestor;
  payloads: PayloadService;
  quoter: Quoter;
  submitter: Submitter;
  tokenMeta: TokenMeta;
  metrics: Metrics;
  /** Per-token open-exposure rail; persists across passes when supplied (defaults to a disabled tracker). */
  exposure?: ExposureTracker;
  /** Order decoder; defaults to the SDK-backed parsePriorityOrder (injectable for tests). */
  parse?: (order: OpenOrder, chainId: number, wethAddress: Address) => ParsedOrder;
  log?: (msg: string) => void;
}

export interface ShadowResult {
  order: ParsedOrder;
  bidWei: bigint;
  expectedProfitUsdWad: bigint;
  improving: boolean;
}

/** Run one shadow pass: build (but do not send) a fill for every profitable open order. */
export async function runShadowPass(deps: ShadowDeps): Promise<ShadowResult[]> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const parse = deps.parse ?? parsePriorityOrder;
  const { config } = deps;
  const wethAddr = config.addresses.weth as Address;
  const weth = config.addresses.weth.toLowerCase();
  const exposure = deps.exposure ?? createExposureTracker(0n);

  // Payloads must cover EVERY asset with a subscribed Pyth feed, not just the fill pair: the Lazer blob bundles
  // all subscribed feeds, and PythProOracle._parseAndStore reverts (PriceOracle_InvalidCexPrice) for any fresh
  // feed lacking a matching signed CEX price. Same reason the limit-order-bot sends ALL cached prices
  // (GetAllPriceForAmm). This also guarantees the WETH price is present for USD gas costing.
  const allAssets = allPoolAssets(config);

  const block = await deps.provider.getBlock("latest");
  const baseFeeWei = block?.baseFeePerGas ?? 0n;

  const open = await deps.ingestor.poll();
  deps.metrics.inc("orders.seen", open.length);
  const results: ShadowResult[] = [];

  for (const order of open) {
    let parsed: ParsedOrder;
    try {
      parsed = parse(order, config.chainId, wethAddr);
    } catch (err) {
      deps.metrics.inc("orders.parseError");
      log(`skip ${order.orderHash.slice(0, 10)}: parse error: ${(err as Error).message}`);
      continue;
    }

    try {
      const payloads = await deps.payloads.getPayloads(allAssets);
      const quote = await deps.quoter.quoteExactIn(parsed.tokenIn, parsed.tokenOut, parsed.amountIn, payloads);
      deps.metrics.inc("orders.quoted");
      if (!quote) {
        deps.metrics.inc("orders.noPath");
        continue;
      }

      const priceOf = (t: Address) => payloads.prices.find((p) => p.token.toLowerCase() === t.toLowerCase())?.priceWad;
      const priceInWad = priceOf(parsed.tokenIn);
      const priceOutWad = priceOf(parsed.tokenOut);
      if (priceInWad === undefined || priceOutWad === undefined) {
        deps.metrics.inc("orders.noPrice");
        continue;
      }
      const nativePriceWad = payloads.prices.find((p) => p.token.toLowerCase() === weth)?.priceWad;

      const [decimalsIn, decimalsOut] = await Promise.all([
        deps.tokenMeta.decimalsOf(parsed.tokenIn),
        deps.tokenMeta.decimalsOf(parsed.tokenOut),
      ]);

      const ctx: BidContext = {
        priceOutWad,
        decimalsOut,
        nativePriceWad,
        gasEstimate: BigInt(config.strategy.gasEstimate),
        baseFeeWei,
        spreadCaptureBps: config.strategy.spreadCaptureBps,
        improvingShadeBps: config.strategy.improvingDirectionShadeBps,
        worseningShadeBps: config.strategy.worseningDirectionShadeBps,
        maxBidWei: BigInt(config.strategy.maxBidPriorityFeeWei),
        minProfitUsdWad: BigInt(config.strategy.minProfitUsdWad),
        maxNotionalUsdWad: BigInt(config.caps.maxNotionalUsdWadPerFill),
        notionalUsdWad: usdWad(parsed.amountIn, decimalsIn, priceInWad),
      };

      const result = decideBid(parsed, quote, ctx);
      if (result.kind === "skip") {
        deps.metrics.inc(`skip.${result.reason.replace(/\s+/g, "_")}`);
        log(`skip ${order.orderHash.slice(0, 10)}: ${result.reason}`);
        continue;
      }

      const d = result.decision;

      // Pyth verification fee to forward with the fill. The router's swapExactIn forwards msg.value to
      // PythProOracle._updatePriceFeedsArray, which requires `msg.value >= verification_fee() × n` where n =
      // the number of NON-EMPTY updateData array elements (one verifyUpdate call, one flat fee, per blob — NOT
      // per feed inside the blob; see ryze-contracts PythProOracle.sol:344-352). We send a single bundled blob,
      // so n = 1. Excess is not refunded, so do not overpay.
      const nonEmptyBlobs = payloads.pythUpdateData.filter((b) => b && b !== "0x").length;
      const pythFeeWei = BigInt(config.oracle.pythVerificationFeeWei) * BigInt(nonEmptyBlobs);

      // Open-exposure rail: cap how much of the settlement token we'd commit at once. Exposure is held only
      // while a fill is actually in flight — see the release below for the shadow (not-sent) case.
      if (!exposure.canAdd(parsed.tokenOut, ctx.notionalUsdWad)) {
        deps.metrics.inc("skip.exposure_over_cap");
        log(`skip ${order.orderHash.slice(0, 10)}: exposure over cap for ${parsed.tokenOut}`);
        continue;
      }
      exposure.add(parsed.tokenOut, ctx.notionalUsdWad);

      // Build (do NOT send) the fill tx to prove the whole path is executable in shadow mode.
      const outcome = await deps.submitter.submit({
        encodedOrder: parsed.encodedOrder,
        signature: parsed.signature,
        path: quote.path,
        minAmountOut: d.orderOwedOut,
        deadline: parsed.deadline,
        pythUpdateData: payloads.pythUpdateData,
        cexPriceData: payloads.cexPriceData,
        pythFeeWei,
        bidWei: d.bidWei,
        baseFeeWei,
        gasLimit: BigInt(config.strategy.gasEstimate),
      });

      // Nothing was sent (shadow), so nothing is actually committed — release immediately. Without this the
      // tracker only ever ratchets up and a long shadow run degenerates into all-skip `exposure_over_cap`.
      // The live path (sent=true, M4) must instead hold until the fill settles/reverts.
      if (!outcome.sent) exposure.release(parsed.tokenOut, ctx.notionalUsdWad);

      deps.metrics.inc("orders.bid");
      if (d.expectedProfitUsdWad > 0n) deps.metrics.inc("orders.profitable");
      results.push({
        order: parsed,
        bidWei: d.bidWei,
        expectedProfitUsdWad: d.expectedProfitUsdWad,
        improving: d.improving,
      });
      log(
        `bid ${order.orderHash.slice(0, 10)} ${parsed.tokenIn}->${parsed.tokenOut} ` +
          `bid=${d.bidWei}wei effFee=${d.effectivePriorityFeeWei} owed=${d.orderOwedOut} ` +
          `keepOut=${d.capturedSpreadOut} profitUsd=${d.expectedProfitUsdWad} gasUsd=${d.gasCostUsdWad} ` +
          `${d.improving ? "improving" : "worsening"} sent=${outcome.sent}`,
      );
    } catch (err) {
      deps.metrics.inc("orders.error");
      log(`skip ${order.orderHash.slice(0, 10)}: ${(err as Error).message}`);
    }
  }

  const s = deps.payloads.stats();
  log(`shadow pass: bids=${results.length}/${open.length} payloadCache hits=${s.hits} misses=${s.misses}`);
  return results;
}
