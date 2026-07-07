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

/** One output leg for multi-output economics: its baseline amount and per-wei scaling factor. */
export interface OutputLeg {
  amount: bigint;
  mpsPerWei: bigint;
}

/** Total baseline output across all legs (effective priority fee 0). */
export function sumBaseOutput(legs: OutputLeg[]): bigint {
  let s = 0n;
  for (const l of legs) s += l.amount;
  return s;
}

/**
 * Aggregate scaling weight `Σ amount·mpsPerWei` across legs. The extra output owed grows ≈ `weight·effFee/MPS`,
 * so this is the slope used to invert a target extra-output back to an effective priority fee.
 */
export function outputWeight(legs: OutputLeg[]): bigint {
  let w = 0n;
  for (const l of legs) w += l.amount * l.mpsPerWei;
  return w;
}

/** Exact total output owed across all legs at an effective priority fee (each leg rounds up, as on-chain). */
export function totalOwedAtEffFee(legs: OutputLeg[], effFeeWei: bigint): bigint {
  let s = 0n;
  for (const l of legs) s += scaleOutputUp(l.amount, l.mpsPerWei, effFeeWei);
  return s;
}

/**
 * Smallest effective priority fee (wei) whose scaled-up outputs give the swapper at least `extraOut` more total
 * output, given the aggregate `weight` = `Σ amount·mpsPerWei`. Inverts {totalOwedAtEffFee}'s linear slope,
 * rounding up so the target is met. Returns 0 if `extraOut <= 0` or `weight == 0`.
 */
export function effFeeForExtraOutWeighted(weight: bigint, extraOut: bigint): bigint {
  if (extraOut <= 0n || weight <= 0n) return 0n;
  return mulDivUp(extraOut, MPS, weight);
}

/**
 * Gross spread in output-token units at a bid: what Ryze delivers minus what the order owes the swapper.
 * Positive means the fill is profitable before gas.
 */
export function grossSpread(ryzeNetOut: bigint, orderOwedOut: bigint): bigint {
  return ryzeNetOut - orderOwedOut;
}

/** USD value (WAD) of `amount` base units of a token with `decimals`, priced at `priceWad` per full token. */
export function usdWad(amount: bigint, decimals: number, priceWad: bigint): bigint {
  return (amount * priceWad) / 10n ** BigInt(decimals);
}

/**
 * The extra output an order owes when the effective priority fee rises from 0 to `effFeeWei`
 * (output-scaling orders only): `ceil(baseOutput * (MPS + effFee*mps)/MPS) - baseOutput`.
 */
export function extraOutputFromEffFee(baseOutput: bigint, mpsPerWei: bigint, effFeeWei: bigint): bigint {
  return scaleOutputUp(baseOutput, mpsPerWei, effFeeWei) - baseOutput;
}

/**
 * Smallest effective priority fee (wei) whose scaled-up output gives the swapper at least `extraOut` more output
 * (output-scaling orders, `mpsPerWei > 0`). Inverts `extraOutputFromEffFee`, rounding up so the target is met.
 * Returns 0 if `extraOut <= 0` or `mpsPerWei == 0`.
 */
export function effFeeForExtraOut(baseOutput: bigint, mpsPerWei: bigint, extraOut: bigint): bigint {
  if (extraOut <= 0n || mpsPerWei === 0n || baseOutput === 0n) return 0n;
  // extraOut ≈ baseOutput * effFee * mpsPerWei / MPS  ⇒  effFee ≈ extraOut * MPS / (baseOutput * mpsPerWei)
  return mulDivUp(extraOut, MPS, baseOutput * mpsPerWei);
}
