// strategy: the Dutch_V3 fill decision. Unlike Priority (where we chose a priority-fee bid that set the owed
// output), a Dutch_V3 order's owed output is FIXED by its block-decay curve at each block — our only levers are
// (a) whether to fill and (b) at which block (decay makes the fill cheaper the longer we wait, bounded by
// competition and the exclusivity window). The chosen priority fee is a pure inclusion/gas-race knob; it does NOT
// change what the swapper is owed.
import type { ParsedOrder, RyzeQuote } from "../types.js";
import {
  resolveOwedForFiller,
  resolveOutputOwedAtBlock,
  usdWad,
  UNFILLABLE_EXCLUSIVE,
} from "./economics.js";

/** Would-be economics of filling `order` with `quote` at a given block (for dry-run / shadow P&L logging). */
export interface FillEconomics {
  orderHash: string;
  /** Output the order owes the swapper at this block (decayed; incl. any exclusivity handicap for us). */
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
 * Would-be economics of filling `order` at `blockNumber`, from `filler`'s perspective (exclusivity handicap
 * included). Used by the M2 dry-run to log P&L including sessionized fees. Gas is tracked separately.
 */
export function evaluateFill(order: ParsedOrder, quote: RyzeQuote, filler: string, blockNumber: number): FillEconomics {
  const owed = resolveOwedForFiller(order, filler, blockNumber);
  // Strict-exclusivity, in-window: we cannot fill — report a non-positive spread so it is treated as unprofitable.
  const orderOwedOut = owed === UNFILLABLE_EXCLUSIVE ? resolveOutputOwedAtBlock(order, blockNumber) : owed;
  const grossSpreadOut = owed === UNFILLABLE_EXCLUSIVE ? 0n - quote.netAmountOut : quote.netAmountOut - owed;
  return {
    orderHash: order.orderHash,
    orderOwedOut,
    ryzeNetOut: quote.netAmountOut,
    grossSpreadOut,
    sessionizedSlippage: quote.sessionizedSlippage ?? 0n,
    sessionizedWbf: quote.sessionizedWbf ?? 0n,
    wbrCredit: quote.wbrCredit ?? 0n,
  };
}

/** Context the fill decision needs beyond the order + quote: prices, decimals, gas, and configured knobs/caps. */
export interface FillContext {
  /** Our executor address — decides whether we are the order's exclusive filler (no handicap) or not. */
  filler: string;
  /** Price per full token (WAD) for tokenOut and (optionally) the native gas token. */
  priceOutWad: bigint;
  decimalsOut: number;
  /** Native (ETH) price per full token (WAD) for gas costing; if absent, gas is excluded from profit. */
  nativePriceWad?: bigint;
  /** Assumed gas units for the fill. */
  gasEstimate: bigint;
  /** Current block base fee (wei). */
  baseFeeWei: bigint;
  /** Inclusion priority fee (wei) — the gas-race knob attached to the tx. Does NOT change owed output. */
  inclusionPriorityFeeWei: bigint;
  /** Minimum expected USD (WAD) profit to fill. */
  minProfitUsdWad: bigint;
  /** Per-fill notional cap (USD WAD); 0 disables. */
  maxNotionalUsdWad: bigint;
  /** Notional of this fill (USD WAD), for the cap check. */
  notionalUsdWad: bigint;
}

export interface FillDecision {
  /** Block the decision was evaluated at (the intended fill block). */
  blockNumber: number;
  /** Output we must deliver = the router-side `minAmountOut` (decayed owed, incl. exclusivity handicap). */
  orderOwedOut: bigint;
  /** Inclusion priority fee (wei) to attach to the fill tx (gas-race only). */
  inclusionPriorityFeeWei: bigint;
  /** Filler-kept spread in output-token units. */
  capturedSpreadOut: bigint;
  capturedSpreadUsdWad: bigint;
  gasCostUsdWad: bigint;
  expectedProfitUsdWad: bigint;
  /** Improving-direction heuristic (WBR paid / no sessionized WBF): observability + pair/skip signal. */
  improving: boolean;
}

export type FillResult = { kind: "fill"; decision: FillDecision } | { kind: "skip"; reason: string };

/** Improving-direction heuristic: the pool paid a WBR or charged no sessionized WBF ⇒ trade improves weights. */
function isImproving(quote: RyzeQuote): boolean {
  return (quote.wbrCredit ?? 0n) > 0n || (quote.sessionizedWbf ?? 0n) === 0n;
}

/**
 * Decide whether to fill `order` at `blockNumber`.
 *
 * The curve fixes `owed`; there is no bid search and no swapper-offer term. We fill iff Ryze's net output exceeds
 * what we owe (spread > 0) AND the captured spread minus gas clears the min-profit floor. `minAmountOut` is set to
 * exactly `owed`. Improving-direction awareness is kept as a signal only (not MPS shading).
 */
export function decideFill(order: ParsedOrder, quote: RyzeQuote, ctx: FillContext, blockNumber: number): FillResult {
  // An order whose legs span multiple settlement tokens can't be sourced by a single Ryze swap.
  if (order.multiToken) return { kind: "skip", reason: "multi-token outputs" };

  if (ctx.maxNotionalUsdWad > 0n && ctx.notionalUsdWad > ctx.maxNotionalUsdWad) {
    return { kind: "skip", reason: "notional over cap" };
  }

  const owed = resolveOwedForFiller(order, ctx.filler, blockNumber);
  if (owed === UNFILLABLE_EXCLUSIVE) return { kind: "skip", reason: "strict exclusivity" };

  const capturedSpreadOut = quote.netAmountOut - owed;
  if (capturedSpreadOut <= 0n) return { kind: "skip", reason: "no spread" };

  const capturedSpreadUsdWad = usdWad(capturedSpreadOut, ctx.decimalsOut, ctx.priceOutWad);
  const gasWei = (ctx.baseFeeWei + ctx.inclusionPriorityFeeWei) * ctx.gasEstimate;
  const gasCostUsdWad = ctx.nativePriceWad !== undefined ? usdWad(gasWei, 18, ctx.nativePriceWad) : 0n;
  const expectedProfitUsdWad = capturedSpreadUsdWad - gasCostUsdWad;

  if (expectedProfitUsdWad < ctx.minProfitUsdWad) {
    return { kind: "skip", reason: "below min profit" };
  }

  return {
    kind: "fill",
    decision: {
      blockNumber,
      orderOwedOut: owed,
      inclusionPriorityFeeWei: ctx.inclusionPriorityFeeWei,
      capturedSpreadOut,
      capturedSpreadUsdWad,
      gasCostUsdWad,
      expectedProfitUsdWad,
      improving: isImproving(quote),
    },
  };
}
