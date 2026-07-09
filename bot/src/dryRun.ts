// dry-run (M2): poll live Base Dutch_V3 orders, quote them through Ryze, and log would-be P&L incl. sessionized
// fees. Sends NO transactions. This is the M3 shadow loop minus the submitter.
import type { Ingestor } from "./ingestor/index.js";
import { parseDutchV3Order } from "./ingestor/index.js";
import type { PayloadService } from "./payloads/index.js";
import type { Quoter } from "./quoter/index.js";
import type { Metrics } from "./metrics/index.js";
import { evaluateFill, type FillEconomics } from "./strategy/index.js";
import { resolveInputAtBlock } from "./strategy/economics.js";
import type { Address, ParsedOrder } from "./types.js";

export interface DryRunDeps {
  chainId: number;
  /** WETH address, used to normalize native-ETH output legs to their settlement token. */
  weth: Address;
  /** Our executor address — decides the exclusivity handicap in the would-be owed. */
  filler: Address;
  /** All configured pool assets — payloads are fetched for the full set (one cache key, same as shadow). */
  assets: Address[];
  ingestor: Ingestor;
  payloads: PayloadService;
  quoter: Quoter;
  metrics: Metrics;
  /** Line logger (defaults to console.log). */
  log?: (msg: string) => void;
}

/** Run a single dry-run pass over currently-open orders; returns the evaluated economics per quoted order. */
export async function runDryRunPass(deps: DryRunDeps): Promise<FillEconomics[]> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const open = await deps.ingestor.poll();
  deps.metrics.inc("orders.seen", open.length);

  const results: FillEconomics[] = [];
  for (const order of open) {
    let parsed: ParsedOrder;
    try {
      parsed = parseDutchV3Order(order, deps.chainId, deps.weth);
    } catch (err) {
      deps.metrics.inc("orders.parseError");
      log(`skip ${order.orderHash.slice(0, 10)}: parse error: ${(err as Error).message}`);
      continue;
    }

    // Would-be fill just after the exclusivity window closes (decayStartBlock + 1): the realistic point at which a
    // polling filler (never the exclusive one) can win — no exclusivity handicap, decay just begun.
    const evalBlock = parsed.decayStartBlock + 1;
    const amountIn = resolveInputAtBlock(parsed, evalBlock);

    try {
      const payloads = await deps.payloads.getPayloads(deps.assets);
      const quote = await deps.quoter.quoteExactIn(parsed.tokenIn, parsed.tokenOut, amountIn, payloads);
      deps.metrics.inc("orders.quoted");
      if (!quote) {
        deps.metrics.inc("orders.noPath");
        log(`skip ${order.orderHash.slice(0, 10)}: no Ryze path or missing prices`);
        continue;
      }
      const econ = evaluateFill(parsed, quote, deps.filler, evalBlock);
      results.push(econ);
      if (econ.grossSpreadOut > 0n) deps.metrics.inc("orders.profitable");
      log(
        `quote ${order.orderHash.slice(0, 10)} ${parsed.tokenIn}->${parsed.tokenOut} ` +
          `in=${amountIn} ryzeOut=${econ.ryzeNetOut} owed=${econ.orderOwedOut} ` +
          `spread=${econ.grossSpreadOut} slip=${econ.sessionizedSlippage} wbf=${econ.sessionizedWbf} wbr=${econ.wbrCredit}`,
      );
    } catch (err) {
      deps.metrics.inc("orders.quoteError");
      log(`skip ${order.orderHash.slice(0, 10)}: quote error: ${(err as Error).message}`);
    }
  }

  const s = deps.payloads.stats();
  log(`pass done: quoted=${results.length}/${open.length} payloadCache hits=${s.hits} misses=${s.misses}`);
  return results;
}
