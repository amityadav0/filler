// strategy (M2 preview / M3 full): would-be P&L for a quoted order. Bid optimization + shading + caps land in M3.
import type { ParsedOrder, RyzeQuote } from "../types.js";
import { grossSpread, orderOutputAtBid, MPS } from "./economics.js";

export { MPS };

/** Would-be economics of filling `order` with `quote` at a candidate `bidWei`, all in output-token units. */
export interface FillEconomics {
  orderHash: string;
  /** Output the order owes the swapper at this bid (baseline output scaled up by the effective priority fee). */
  orderOwedOut: bigint;
  /** Ryze net output the executor would receive. */
  ryzeNetOut: bigint;
  /** ryzeNetOut − orderOwedOut, before gas. Positive ⇒ profitable pre-gas. */
  grossSpreadOut: bigint;
  /** Sessionized fees the quote already priced in (observability). */
  sessionizedSlippage: bigint;
  sessionizedWbf: bigint;
  wbrCredit: bigint;
}

/**
 * Compute would-be fill economics at a bid. Used by the M2 dry-run to log P&L including sessionized fees.
 * Gas is tracked separately by the submitter (denominated in the fee token, not the output token).
 */
export function evaluateFill(order: ParsedOrder, quote: RyzeQuote, bidWei: bigint): FillEconomics {
  const orderOwedOut = orderOutputAtBid(
    order.baselineAmountOut,
    order.outputMpsPerWei,
    bidWei,
    order.baselinePriorityFeeWei,
  );
  return {
    orderHash: order.orderHash,
    orderOwedOut,
    ryzeNetOut: quote.netAmountOut,
    grossSpreadOut: grossSpread(quote.netAmountOut, orderOwedOut),
    sessionizedSlippage: quote.sessionizedSlippage ?? 0n,
    sessionizedWbf: quote.sessionizedWbf ?? 0n,
    wbrCredit: quote.wbrCredit ?? 0n,
  };
}
