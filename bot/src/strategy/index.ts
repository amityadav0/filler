// strategy (M3): profit calc, MPS→priority-fee bid, direction shading, risk caps.
import type { RyzeQuote } from "../types.js";
import type { OpenOrder } from "../ingestor/index.js";

/** UniswapX priority MPS constant: 1e7 milli-basis-points per wei of priority fee. */
export const MPS = 10_000_000n;

export interface Bid {
  maxPriorityFeePerGasWei: bigint;
  expectedProfitWei: bigint;
}

export interface Strategy {
  /** Decide a priority-fee bid for an order given the Ryze quote, or null to skip. */
  decide(order: OpenOrder, quote: RyzeQuote): Bid | null;
}

export function createStrategy(): Strategy {
  return {
    decide(): Bid | null {
      throw new Error("strategy not implemented (M3)");
    },
  };
}
