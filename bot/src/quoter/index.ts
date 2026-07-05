// quoter (M2): best Ryze path via WeightedPoolQueries.querySwapExactIn eth_call with from = executor.
import type { Address, PayloadBundle, RyzeQuote } from "../types.js";

export interface Quoter {
  /** Net Ryze output (incl. sessionized fees + WBR) for swapping amountIn of tokenIn → tokenOut. */
  quoteExactIn(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    payloads: PayloadBundle,
  ): Promise<RyzeQuote | null>;
}

export function createQuoter(): Quoter {
  return {
    async quoteExactIn(): Promise<RyzeQuote | null> {
      throw new Error("quoter not implemented (M2)");
    },
  };
}
