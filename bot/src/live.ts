// live loop (M4): the shadow loop plus everything real sending needs — deadline guard, auctionTargetBlock
// timing (a fill mined before the target block reverts OrderNotFillable), the reverted-gas budget, exposure
// held while a fill is in flight, and a re-quote with FRESH payloads immediately before send.
//
// Safety posture: every send is bounded by (a) per-fill notional cap and min-profit floor (strategy),
// (b) per-token open-exposure cap, (c) the rolling reverted-gas budget — once losing bids burn the hourly
// budget, the loop stops bidding until it decays. The owner kill switch is `setOperator(address(0))`.
import type { Provider } from "ethers";
import type { Ingestor, OpenOrder } from "./ingestor/index.js";
import type { PayloadService } from "./payloads/index.js";
import type { Quoter } from "./quoter/index.js";
import type { Metrics } from "./metrics/index.js";
import type { Submitter } from "./submitter/index.js";
import type { TokenMeta } from "./chain/tokens.js";
import type { ExposureTracker, GasBudget } from "./strategy/risk.js";
import type { Address, ParsedOrder } from "./types.js";
import { allPoolAssets, type FillerConfig } from "./config.js";
import { prepareFill, pythFeeFor } from "./prepare.js";

export interface LiveDeps {
  config: FillerConfig;
  provider: Provider;
  ingestor: Ingestor;
  payloads: PayloadService;
  quoter: Quoter;
  /** Must be constructed WITH a signer — `submit(inputs, true)` broadcasts. */
  submitter: Submitter;
  tokenMeta: TokenMeta;
  metrics: Metrics;
  /** Held from send until the fill's receipt (win or revert) lands. */
  exposure: ExposureTracker;
  /** Rolling budget for gas burned on reverted (losing) bids. */
  gasBudget: GasBudget;
  parse?: (order: OpenOrder, chainId: number, wethAddress: Address) => ParsedOrder;
  log?: (msg: string) => void;
  /** Injectable clock/chain hooks for tests. */
  now?: () => number;
  currentBlock?: () => Promise<number>;
  /** Resolve once the chain reaches `blockNumber` (default: poll the provider each second). */
  waitForBlock?: (blockNumber: number) => Promise<void>;
  /** Wait for a tx receipt; null = not mined within the timeout. */
  waitForReceipt?: (txHash: string) => Promise<{ status: number; gasUsed: bigint; gasPrice: bigint } | null>;
}

export interface LiveResult {
  order: ParsedOrder;
  txHash?: `0x${string}`;
  won: boolean;
}

function defaultHooks(deps: LiveDeps) {
  const provider = deps.provider;
  const live = deps.config.live;
  return {
    now: deps.now ?? Date.now,
    currentBlock: deps.currentBlock ?? (() => provider.getBlockNumber()),
    waitForBlock:
      deps.waitForBlock ??
      (async (target: number) => {
        for (;;) {
          if ((await provider.getBlockNumber()) >= target) return;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }),
    waitForReceipt:
      deps.waitForReceipt ??
      (async (txHash: string) => {
        const r = await provider.waitForTransaction(txHash, 1, live.receiptTimeoutMs);
        return r ? { status: r.status ?? 0, gasUsed: r.gasUsed, gasPrice: r.gasPrice ?? 0n } : null;
      }),
  };
}

/** Run one live pass: send a fill for every order that survives strategy, risk rails, and the send-time re-quote. */
export async function runLivePass(deps: LiveDeps): Promise<LiveResult[]> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const { config, exposure, gasBudget } = deps;
  const live = config.live;
  const hooks = defaultHooks(deps);

  const block = await deps.provider.getBlock("latest");
  const baseFeeWei = block?.baseFeePerGas ?? 0n;

  const open = await deps.ingestor.poll();
  deps.metrics.inc("orders.seen", open.length);
  const results: LiveResult[] = [];

  for (const order of open) {
    const id = order.orderHash.slice(0, 10);
    try {
      const prep = await prepareFill(deps, order, baseFeeWei);
      if (!prep) continue;
      const { parsed, ctx, decision: d } = prep;

      // Deadline guard: the order must still be fillable when our tx lands (deadline is unix seconds).
      if (parsed.deadline * 1000 < hooks.now() + live.minDeadlineMs) {
        deps.metrics.inc("skip.deadline_too_close");
        log(`skip ${id}: deadline too close`);
        continue;
      }

      // Target-block gate: sending before auctionTargetBlock reverts OrderNotFillable. Wait when it is near;
      // give up when it is far (payloads/quote would be stale by then — the order will be re-polled... it won't
      // (dedupe), so far-future targets are counted distinctly to size that gap in the data).
      const cur = await hooks.currentBlock();
      const lead = parsed.auctionTargetBlock - cur;
      if (lead > live.maxTargetBlockLeadBlocks) {
        deps.metrics.inc("skip.target_block_too_far");
        log(`skip ${id}: auctionTargetBlock ${parsed.auctionTargetBlock} is ${lead} blocks ahead`);
        continue;
      }

      // Reverted-gas budget: bound the worst case for THIS attempt before committing to it.
      const worstCaseGasWei = (baseFeeWei + d.bidWei) * ctx.gasEstimate;
      if (!gasBudget.canSpend(worstCaseGasWei)) {
        deps.metrics.inc("skip.gas_budget_exhausted");
        log(`skip ${id}: reverted-gas budget exhausted (${gasBudget.spentLastHour()} wei this hour)`);
        continue;
      }

      // Exposure hold: released in `finally` once the receipt (or timeout) resolves — fills settle atomically,
      // so exposure only exists between send and mined receipt.
      if (!exposure.canAdd(parsed.tokenOut, ctx.notionalUsdWad)) {
        deps.metrics.inc("skip.exposure_over_cap");
        log(`skip ${id}: exposure over cap for ${parsed.tokenOut}`);
        continue;
      }
      exposure.add(parsed.tokenOut, ctx.notionalUsdWad);
      try {
        if (lead > live.sendLeadBlocks) {
          await hooks.waitForBlock(parsed.auctionTargetBlock - live.sendLeadBlocks);
        }

        // Re-quote with FRESH payloads immediately before send: the fill tx must carry payloads that pass the
        // oracle's staleness window at mining time, and the spread must still clear what we owe at our bid.
        const freshPayloads = await deps.payloads.getPayloads(allPoolAssets(config));
        const fresh = await deps.quoter.quoteExactIn(parsed.tokenIn, parsed.tokenOut, parsed.amountIn, freshPayloads);
        if (!fresh || fresh.netAmountOut < d.orderOwedOut) {
          deps.metrics.inc("skip.requote_below_owed");
          log(`skip ${id}: re-quote ${fresh?.netAmountOut ?? "none"} below owed ${d.orderOwedOut}`);
          continue;
        }

        const outcome = await deps.submitter.submit(
          {
            encodedOrder: parsed.encodedOrder,
            signature: parsed.signature,
            path: fresh.path,
            minAmountOut: d.orderOwedOut,
            deadline: parsed.deadline,
            pythUpdateData: freshPayloads.pythUpdateData,
            cexPriceData: freshPayloads.cexPriceData,
            pythFeeWei: pythFeeFor(config, freshPayloads),
            bidWei: d.bidWei,
            baseFeeWei,
            gasLimit: BigInt(config.strategy.gasEstimate),
          },
          true,
        );
        deps.metrics.inc("orders.sent");
        log(`sent ${id}: tx=${outcome.txHash} bid=${d.bidWei}wei owed=${d.orderOwedOut} expectUsd=${d.expectedProfitUsdWad}`);

        const receipt = outcome.txHash ? await hooks.waitForReceipt(outcome.txHash) : null;
        if (receipt?.status === 1) {
          deps.metrics.inc("orders.won");
          results.push({ order: parsed, txHash: outcome.txHash, won: true });
          log(`WON ${id}: gasUsed=${receipt.gasUsed} spreadOut≈${d.capturedSpreadOut}`);
        } else {
          // Lost the auction (revert) or unknown (timeout): consume the gas budget — conservatively at the
          // worst-case estimate when the receipt never arrived.
          const spent = receipt ? receipt.gasUsed * receipt.gasPrice : worstCaseGasWei;
          gasBudget.record(spent);
          deps.metrics.inc(receipt ? "orders.reverted" : "orders.receiptTimeout");
          results.push({ order: parsed, txHash: outcome.txHash, won: false });
          log(`LOST ${id}: ${receipt ? `reverted, gas=${spent}wei` : "receipt timeout"} budgetHour=${gasBudget.spentLastHour()}`);
        }
      } finally {
        exposure.release(parsed.tokenOut, ctx.notionalUsdWad);
      }
    } catch (err) {
      deps.metrics.inc("orders.error");
      log(`skip ${id}: ${(err as Error).message}`);
    }
  }

  // Quiet when idle (open orders are rare and short-lived); the loop heartbeat covers liveness.
  if (open.length > 0) {
    const s = deps.payloads.stats();
    log(`live pass: sent=${results.length}/${open.length} won=${results.filter((r) => r.won).length} payloadCache hits=${s.hits} misses=${s.misses}`);
  }
  return results;
}
