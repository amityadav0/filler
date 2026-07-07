// strategy: would-be P&L for a quoted order + priority-fee bid selection with direction shading and risk caps.
import type { ParsedOrder, RyzeQuote } from "../types.js";
import {
  grossSpread,
  effectivePriorityFee,
  effFeeForExtraOutWeighted,
  sumBaseOutput,
  outputWeight,
  totalOwedAtEffFee,
  usdWad,
  MPS,
  type OutputLeg,
} from "./economics.js";

export { MPS };

/** Output legs (baseline amount + scaling factor) for multi-output economics. */
function legsOf(order: ParsedOrder): OutputLeg[] {
  return order.outputs.map((o) => ({ amount: o.amount, mpsPerWei: o.mpsPerWei }));
}

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
  const effFee = effectivePriorityFee(bidWei, order.baselinePriorityFeeWei);
  const orderOwedOut = totalOwedAtEffFee(legsOf(order), effFee);
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

const BPS = 10_000n;

/** Context the bidder needs beyond the order + quote: prices, decimals, gas, and configured knobs/caps. */
export interface BidContext {
  /** Price per full token (WAD) for tokenOut and (optionally) the native gas token. */
  priceOutWad: bigint;
  decimalsOut: number;
  /** Native (ETH) price per full token (WAD) for gas costing; if absent, gas is excluded from profit. */
  nativePriceWad?: bigint;
  /** Assumed gas units for the fill. */
  gasEstimate: bigint;
  /** Current block base fee (wei). */
  baseFeeWei: bigint;
  /** Fraction of the raw spread the filler tries to keep (rest is offered to the swapper), in bps. */
  spreadCaptureBps: number;
  /** Shade capture down on improving-direction flow (bid more aggressively), in bps. */
  improvingShadeBps: number;
  /** Shade capture up on worsening-direction flow (bid less aggressively), in bps. */
  worseningShadeBps: number;
  /** Hard ceiling on the priority-fee bid (wei). */
  maxBidWei: bigint;
  /** Minimum expected USD (WAD) profit to bid. */
  minProfitUsdWad: bigint;
  /** Per-fill notional cap (USD WAD); 0 disables. */
  maxNotionalUsdWad: bigint;
  /** Notional of this fill (USD WAD), for the cap check. */
  notionalUsdWad: bigint;
}

export interface BidDecision {
  bidWei: bigint;
  effectivePriorityFeeWei: bigint;
  orderOwedOut: bigint;
  /** Filler-kept spread in output-token units at this bid. */
  capturedSpreadOut: bigint;
  capturedSpreadUsdWad: bigint;
  gasCostUsdWad: bigint;
  expectedProfitUsdWad: bigint;
  improving: boolean;
}

export type BidResult = { kind: "bid"; decision: BidDecision } | { kind: "skip"; reason: string };

/** Improving-direction heuristic: the pool paid a WBR or charged no sessionized WBF ⇒ trade improves weights. */
function isImproving(quote: RyzeQuote): boolean {
  return (quote.wbrCredit ?? 0n) > 0n || (quote.sessionizedWbf ?? 0n) === 0n;
}

function clampBps(bps: number): bigint {
  const v = BigInt(Math.round(bps));
  if (v < 0n) return 0n;
  if (v > BPS) return BPS;
  return v;
}

/**
 * Choose a priority-fee bid for an order.
 *
 * Raising the effective priority fee scales the swapper's owed output up, so it both shrinks our spread and
 * costs more gas — profit is monotonically decreasing in the bid. We therefore offer the swapper a slice of the
 * raw spread (`1 - capture`) as extra output to stay competitive, keep the rest, and enforce caps/min-profit.
 * Improving-direction flow shades `capture` down (bid up); worsening flow shades it up (bid down).
 */
export function decideBid(order: ParsedOrder, quote: RyzeQuote, ctx: BidContext): BidResult {
  // Unsupported order shapes: an exact-output order (input scales down) is not modeled, and an order whose legs
  // span multiple settlement tokens can't be sourced by a single Ryze swap.
  if (order.inputMpsPerWei > 0n) return { kind: "skip", reason: "input-scaling unsupported" };
  if (order.multiToken) return { kind: "skip", reason: "multi-token outputs" };

  if (ctx.maxNotionalUsdWad > 0n && ctx.notionalUsdWad > ctx.maxNotionalUsdWad) {
    return { kind: "skip", reason: "notional over cap" };
  }

  const legs = legsOf(order);
  // Raw spread at the minimum bid (effective fee 0): the whole surplus available to split, over ALL legs.
  const baseOwed = sumBaseOutput(legs);
  const rawSpread = quote.netAmountOut - baseOwed;
  if (rawSpread <= 0n) return { kind: "skip", reason: "no spread" };

  const improving = isImproving(quote);
  let captureBps = clampBps(ctx.spreadCaptureBps);
  captureBps = improving
    ? clampBps(Number(captureBps) - ctx.improvingShadeBps)
    : clampBps(Number(captureBps) + ctx.worseningShadeBps);

  // Offer the swapper (1 - capture) of the raw spread as extra output, then find the fee that delivers it.
  const offerToSwapper = (rawSpread * (BPS - captureBps)) / BPS;
  const weight = outputWeight(legs);
  let effFee = effFeeForExtraOutWeighted(weight, offerToSwapper);
  let bidWei = order.baselinePriorityFeeWei + effFee;

  // Cap the bid; recompute the effective fee under the ceiling.
  if (bidWei > ctx.maxBidWei) {
    bidWei = ctx.maxBidWei;
    effFee = effectivePriorityFee(bidWei, order.baselinePriorityFeeWei);
  }

  const orderOwedOut = totalOwedAtEffFee(legs, effFee);
  const capturedSpreadOut = quote.netAmountOut - orderOwedOut;
  if (capturedSpreadOut <= 0n) return { kind: "skip", reason: "spread consumed by bid" };

  const capturedSpreadUsdWad = usdWad(capturedSpreadOut, ctx.decimalsOut, ctx.priceOutWad);
  const gasWei = (ctx.baseFeeWei + bidWei) * ctx.gasEstimate;
  const gasCostUsdWad = ctx.nativePriceWad !== undefined ? usdWad(gasWei, 18, ctx.nativePriceWad) : 0n;
  const expectedProfitUsdWad = capturedSpreadUsdWad - gasCostUsdWad;

  if (expectedProfitUsdWad < ctx.minProfitUsdWad) {
    return { kind: "skip", reason: "below min profit" };
  }

  return {
    kind: "bid",
    decision: {
      bidWei,
      effectivePriorityFeeWei: effFee,
      orderOwedOut,
      capturedSpreadOut,
      capturedSpreadUsdWad,
      gasCostUsdWad,
      expectedProfitUsdWad,
      improving,
    },
  };
}
