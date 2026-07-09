// shadow loop (M3): poll live Base orders → quote through Ryze → choose a priority-fee bid → BUILD the fill tx
// (never send) → log would-be P&L. This is the full filler loop minus broadcasting; run it for a week and review
// the shadow P&L logs before going live (M4). The live loop is `live.ts`; both share `prepare.ts`.
import type { Provider } from "ethers";
import type { Ingestor } from "./ingestor/index.js";
import type { PayloadService } from "./payloads/index.js";
import type { Quoter } from "./quoter/index.js";
import type { Metrics } from "./metrics/index.js";
import type { Submitter } from "./submitter/index.js";
import type { TokenMeta } from "./chain/tokens.js";
import type { OpenOrder } from "./ingestor/index.js";
import { createExposureTracker, type ExposureTracker } from "./strategy/risk.js";
import type { Address, ParsedOrder } from "./types.js";
import type { FillerConfig } from "./config.js";
import { prepareFill } from "./prepare.js";

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
  const exposure = deps.exposure ?? createExposureTracker(0n);

  const block = await deps.provider.getBlock("latest");
  const baseFeeWei = block?.baseFeePerGas ?? 0n;

  const open = await deps.ingestor.poll();
  deps.metrics.inc("orders.seen", open.length);
  const results: ShadowResult[] = [];

  for (const order of open) {
    try {
      const prep = await prepareFill(deps, order, baseFeeWei);
      if (!prep) continue;
      const { parsed, payloads, quote, ctx, decision: d, pythFeeWei } = prep;

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
        gasLimit: BigInt(deps.config.strategy.gasEstimate),
      });

      // Nothing was sent (shadow), so nothing is actually committed — release immediately. Without this the
      // tracker only ever ratchets up and a long shadow run degenerates into all-skip `exposure_over_cap`.
      // The live path (live.ts) instead holds until the fill's receipt lands.
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
