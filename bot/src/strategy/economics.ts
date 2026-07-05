// Pure priority-auction economics. Mirrors UniswapX PriorityFeeLib (source-verified, Uniswap/UniswapX main).
//
// A Priority Order carries a baseline (input, outputs) plus `mpsPerPriorityFeeWei` scaling factors. The
// *effective* priority fee — `tx.gasprice - block.basefee - order.baselinePriorityFeeWei`, floored at 0 — scales
// the order in the swapper's favour: outputs scale UP (you owe more), input scales DOWN (you receive less).
// MPS = 1e7 "milli-basis-points" per wei of priority fee.

export const MPS = 10_000_000n;

/** ceil(a * b / d) for non-negative bigints. */
export function mulDivUp(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error("mulDivUp: division by zero");
  const p = a * b;
  return p === 0n ? 0n : (p - 1n) / d + 1n;
}

/** floor(a * b / d) for non-negative bigints. */
export function mulDivDown(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error("mulDivDown: division by zero");
  return (a * b) / d;
}

/**
 * Output amount the swapper is owed at a given effective priority fee (rounds up, favours swapper).
 * `scale(output) = output.amount * (MPS + priorityFee * mpsPerWei) / MPS`.
 */
export function scaleOutputUp(baseAmount: bigint, mpsPerWei: bigint, priorityFeeWei: bigint): bigint {
  if (mpsPerWei === 0n) return baseAmount;
  return mulDivUp(baseAmount, MPS + priorityFeeWei * mpsPerWei, MPS);
}

/**
 * Input amount the filler receives at a given effective priority fee (rounds down, favours swapper).
 * `scale(input) = input.amount * (MPS - priorityFee * mpsPerWei) / MPS`, clamped to 0 once the factor ≥ MPS.
 */
export function scaleInputDown(baseAmount: bigint, mpsPerWei: bigint, priorityFeeWei: bigint): bigint {
  const factor = priorityFeeWei * mpsPerWei;
  if (factor >= MPS) return 0n;
  if (factor === 0n) return baseAmount;
  return mulDivDown(baseAmount, MPS - factor, MPS);
}

/** Effective priority fee (wei) an order sees: `bid - baselinePriorityFeeWei`, floored at 0. */
export function effectivePriorityFee(bidWei: bigint, baselinePriorityFeeWei: bigint): bigint {
  const d = bidWei - baselinePriorityFeeWei;
  return d > 0n ? d : 0n;
}

/** The order's owed output at a bid, given its single scaled output. */
export function orderOutputAtBid(
  baseOutput: bigint,
  mpsPerWei: bigint,
  bidWei: bigint,
  baselinePriorityFeeWei: bigint,
): bigint {
  return scaleOutputUp(baseOutput, mpsPerWei, effectivePriorityFee(bidWei, baselinePriorityFeeWei));
}

/**
 * Gross spread in output-token units at a bid: what Ryze delivers minus what the order owes the swapper.
 * Positive means the fill is profitable before gas.
 */
export function grossSpread(ryzeNetOut: bigint, orderOwedOut: bigint): bigint {
  return ryzeNetOut - orderOwedOut;
}
