// shadow loop (M3): poll live Base Dutch_V3 orders → quote through Ryze → decide whether to fill → BUILD the fill
// tx (never send) → log would-be P&L. This is the full filler loop minus broadcasting; run it for a week and
// review the shadow P&L logs before going live (M4). The live loop is `live.ts`; both share `prepare.ts`.
//
// Shadow evaluates at the CURRENT block (a would-be "fill now" view). For orders still inside a foreign
// exclusivity window the owed output carries the exclusivity handicap, so most addressable orders will show as
// unprofitable — the expected outcome given the audit (polling loses to RFQ incumbents; see DUTCH-V3-AUDIT.md).
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
  /** Order decoder; defaults to the SDK-backed parseDutchV3Order (injectable for tests). */
  parse?: (order: OpenOrder, chainId: number, wethAddress: Address) => ParsedOrder;
  log?: (msg: string) => void;
}

export interface ShadowResult {
  order: ParsedOrder;
  inclusionPriorityFeeWei: bigint;
  expectedProfitUsdWad: bigint;
  improving: boolean;
}

/** Run one shadow pass: build (but do not send) a fill for every profitable open order. */
export async function runShadowPass(deps: ShadowDeps): Promise<ShadowResult[]> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const exposure = deps.exposure ?? createExposureTracker(0n);

  const block = await deps.provider.getBlock("latest");
  const baseFeeWei = block?.baseFeePerGas ?? 0n;
  const blockNumber = block?.number ?? 0;

  const open = await deps.ingestor.poll();
  deps.metrics.inc("orders.seen", open.length);
  const results: ShadowResult[] = [];

  for (const order of open) {
    try {
      const prep = await prepareFill(deps, order, baseFeeWei, blockNumber);
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
        inclusionPriorityFeeWei: d.inclusionPriorityFeeWei,
        baseFeeWei,
        gasLimit: BigInt(deps.config.strategy.gasEstimate),
      });

      // Nothing was sent (shadow), so nothing is actually committed — release immediately. Without this the
      // tracker only ever ratchets up and a long shadow run degenerates into all-skip `exposure_over_cap`.
      // The live path (live.ts) instead holds until the fill's receipt lands.
      if (!outcome.sent) exposure.release(parsed.tokenOut, ctx.notionalUsdWad);

      deps.metrics.inc("orders.fill");
      if (d.expectedProfitUsdWad > 0n) deps.metrics.inc("orders.profitable");
      results.push({
        order: parsed,
        inclusionPriorityFeeWei: d.inclusionPriorityFeeWei,
        expectedProfitUsdWad: d.expectedProfitUsdWad,
        improving: d.improving,
      });
      log(
        `fill ${order.orderHash.slice(0, 10)} ${parsed.tokenIn}->${parsed.tokenOut} ` +
          `tip=${d.inclusionPriorityFeeWei}wei owed=${d.orderOwedOut} block=${d.blockNumber} ` +
          `keepOut=${d.capturedSpreadOut} profitUsd=${d.expectedProfitUsdWad} gasUsd=${d.gasCostUsdWad} ` +
          `${d.improving ? "improving" : "worsening"} sent=${outcome.sent}`,
      );
    } catch (err) {
      deps.metrics.inc("orders.error");
      log(`skip ${order.orderHash.slice(0, 10)}: ${(err as Error).message}`);
    }
  }

  // Open orders are short-lived; only log passes that actually saw one, or a week-long shadow log is 86k lines of
  // "fills=0/0". The loop heartbeat (index.ts) covers liveness.
  if (open.length > 0) {
    const s = deps.payloads.stats();
    log(`shadow pass: fills=${results.length}/${open.length} payloadCache hits=${s.hits} misses=${s.misses}`);
  }
  return results;
}
