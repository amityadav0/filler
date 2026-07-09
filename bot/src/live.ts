// live loop (M4): the shadow loop plus everything real sending needs — deadline guard, Dutch **decay/exclusivity
// timing**, the reverted-gas budget, exposure held while a fill is in flight, and a re-quote with FRESH payloads
// immediately before send.
//
// Dutch_V3 timing (replaces Priority's auctionTargetBlock gating): a UniswapX V3 order's owed output is fixed by
// its decay curve, and exclusivity is enforced by the reactor up to `decayStartBlock` — a filler that is not the
// order's `exclusiveFiller` owes `+exclusivityOverrideBps` on outputs while `block <= decayStartBlock` (or CANNOT
// fill at all under strict exclusivity, override == 0). So for the orders we reach by polling (we are never the
// exclusive filler without RFQ — see DUTCH-V3-AUDIT.md / Phase 6), the right move is to wait until just past
// `decayStartBlock`: the exclusivity handicap disappears and the output has begun decaying in our favour. We wait
// at most `maxDecayWaitBlocks` and never past the deadline; we do NOT speculatively wait for further decay (a
// competitor takes a profitable order first).
//
// Safety posture: every send is bounded by (a) per-fill notional cap and min-profit floor (strategy),
// (b) per-token open-exposure cap, (c) the rolling reverted-gas budget. The owner kill switch is
// `setOperator(address(0))`.
import type { Provider } from "ethers";
import type { Ingestor, OpenOrder } from "./ingestor/index.js";
import { parseDutchV3Order } from "./ingestor/index.js";
import type { PayloadService } from "./payloads/index.js";
import type { Quoter } from "./quoter/index.js";
import type { Metrics } from "./metrics/index.js";
import type { Submitter } from "./submitter/index.js";
import type { TokenMeta } from "./chain/tokens.js";
import type { ExposureTracker, GasBudget } from "./strategy/risk.js";
import type { Address, ParsedOrder } from "./types.js";
import { allPoolAssets, type FillerConfig } from "./config.js";
import { prepareFill, pythFeeFor } from "./prepare.js";

/** Base produces ~2s blocks; used only to estimate wall-clock for the deadline guard when waiting for decay. */
const BLOCK_TIME_MS = 2000;

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

/**
 * Intended fill block for a polled order: if someone else holds exclusivity and we're still inside the window
 * (`block <= decayStartBlock`), wait until `decayStartBlock + 1` so the handicap drops and decay has started;
 * otherwise fill at the current block.
 */
function intendedFillBlock(order: ParsedOrder, filler: string, currentBlock: number): number {
  const excl = order.exclusiveFiller.toLowerCase();
  const weAreExclusive = excl === filler.toLowerCase();
  const hasExclusive = excl !== "0x0000000000000000000000000000000000000000";
  if (hasExclusive && !weAreExclusive && currentBlock <= order.decayStartBlock) {
    return order.decayStartBlock + 1;
  }
  return currentBlock;
}

/** Run one live pass: send a fill for every order that survives strategy, risk rails, and the send-time re-quote. */
export async function runLivePass(deps: LiveDeps): Promise<LiveResult[]> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const { config, exposure, gasBudget } = deps;
  const live = config.live;
  const hooks = defaultHooks(deps);
  const parse = deps.parse ?? parseDutchV3Order;
  const wethAddr = config.addresses.weth as Address;
  const executor = config.addresses.executor;

  const open = await deps.ingestor.poll();
  deps.metrics.inc("orders.seen", open.length);
  const results: LiveResult[] = [];

  for (const order of open) {
    const id = order.orderHash.slice(0, 10);
    try {
      // Light parse first — decide decay/exclusivity timing before doing the (costly) quote at the fill block.
      let timing: ParsedOrder;
      try {
        timing = parse(order, config.chainId, wethAddr);
      } catch (err) {
        deps.metrics.inc("orders.parseError");
        log(`skip ${id}: parse error: ${(err as Error).message}`);
        continue;
      }

      const cur = await hooks.currentBlock();
      const target = intendedFillBlock(timing, executor, cur);
      const wait = target - cur;

      if (wait > live.maxDecayWaitBlocks) {
        deps.metrics.inc("skip.decay_wait_too_long");
        log(`skip ${id}: fill block ${target} is ${wait} blocks out (exclusivity window ends at ${timing.decayStartBlock})`);
        continue;
      }

      // Deadline guard: the order must still be fillable when our tx lands (deadline is unix seconds), including
      // any decay-wait we're about to do.
      const estTargetMs = hooks.now() + Math.max(0, wait) * BLOCK_TIME_MS;
      if (timing.deadline * 1000 < estTargetMs + live.minDeadlineMs) {
        deps.metrics.inc("skip.deadline_too_close");
        log(`skip ${id}: deadline too close`);
        continue;
      }

      if (wait > 0) await hooks.waitForBlock(target);

      // Refresh base fee + block AFTER any wait, then evaluate at the reached block (fresh quote + decision, with
      // exclusivity handicap correctly dropped once past decayStartBlock).
      const block = await deps.provider.getBlock("latest");
      const baseFeeWei = block?.baseFeePerGas ?? 0n;
      const atBlock = await hooks.currentBlock();
      const prep = await prepareFill(deps, order, baseFeeWei, atBlock);
      if (!prep) continue;
      const { parsed, ctx, decision: d } = prep;

      // Reverted-gas budget: bound the worst case for THIS attempt before committing to it.
      const worstCaseGasWei = (baseFeeWei + d.inclusionPriorityFeeWei) * ctx.gasEstimate;
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
        // Re-quote with FRESH payloads immediately before send: the fill tx must carry payloads that pass the
        // oracle's staleness window at mining time, and the spread must still clear what we owe.
        const freshPayloads = await deps.payloads.getPayloads(allPoolAssets(config));
        const fresh = await deps.quoter.quoteExactIn(parsed.tokenIn, parsed.tokenOut, prep.amountIn, freshPayloads);
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
            inclusionPriorityFeeWei: d.inclusionPriorityFeeWei,
            baseFeeWei,
            gasLimit: BigInt(config.strategy.gasEstimate),
          },
          true,
        );
        deps.metrics.inc("orders.sent");
        log(`sent ${id}: tx=${outcome.txHash} tip=${d.inclusionPriorityFeeWei}wei owed=${d.orderOwedOut} block=${atBlock} expectUsd=${d.expectedProfitUsdWad}`);

        const receipt = outcome.txHash ? await hooks.waitForReceipt(outcome.txHash) : null;
        if (receipt?.status === 1) {
          deps.metrics.inc("orders.won");
          results.push({ order: parsed, txHash: outcome.txHash, won: true });
          log(`WON ${id}: gasUsed=${receipt.gasUsed} spreadOut≈${d.capturedSpreadOut}`);
        } else {
          // Lost the race (revert) or unknown (timeout): consume the gas budget — conservatively at the
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
