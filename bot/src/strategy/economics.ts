// Dutch_V3 block-decay economics. Mirrors UniswapX on-chain resolution to the wei so our off-chain `owed` matches
// what the reactor will require at fill time.
//
// Source-verified against @uniswap/uniswapx-sdk 3.0.10 `NonLinearDutchDecayLib` (dist/.../utils/dutchBlockDecay.js)
// and Uniswap/UniswapX `src/lib/NonlinearDutchDecayLib.sol` + `V3DutchOrderReactor._resolve` + `ExclusivityLib`:
//   - decay is piecewise-linear in the curve's (relativeBlock, startAmount - relativeAmount) points, anchored at
//     `decayStartBlock`, clamped to startAmount before the first point and to the last point after it;
//   - exclusivity: while `block <= decayStartBlock` a filler that is NOT the `exclusiveFiller` owes outputs scaled
//     UP by `exclusivityOverrideBps` (rounded up, favouring the swapper); `overrideBps == 0` means STRICT
//     exclusivity (the reactor reverts for non-exclusive fillers). After `decayStartBlock` anyone may fill with no
//     handicap. `decayStartBlock` is BOTH the decay anchor and the exclusivity-window end (single field).

import type { DecayCurve, ParsedOrder } from "../types.js";

export const BPS = 10_000n;

/** ceil(a * b / d) for non-negative bigints. */
export function mulDivUp(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error("mulDivUp: division by zero");
  const p = a * b;
  return p === 0n ? 0n : (p - 1n) / d + 1n;
}

/**
 * Linear interpolation between two curve points, matching `NonlinearDutchDecayLib.linearDecay` EXACTLY, including
 * its rounding: the magnitude is floor-divided as a positive quantity and only then signed, so a decreasing
 * segment rounds toward `startAmount` (never below the true line) the same way the contract does.
 */
function linearDecay(
  startPoint: number,
  endPoint: number,
  currentPoint: number,
  startAmount: bigint,
  endAmount: bigint,
): bigint {
  if (currentPoint >= endPoint) return endAmount;
  const elapsed = BigInt(currentPoint - startPoint);
  const duration = BigInt(endPoint - startPoint);
  if (endAmount < startAmount) {
    // Compute the positive decrement with floor division FIRST, then negate (mirrors the contract's
    // `0 - (startAmount - endAmount) * elapsed / duration`; negating after flooring matters for exactness).
    const dec = ((startAmount - endAmount) * elapsed) / duration;
    return startAmount - dec;
  }
  const inc = ((endAmount - startAmount) * elapsed) / duration;
  return startAmount + inc;
}

/** Position of the two curve points bracketing `currentRelativeBlock` (mirrors `locateArrayPosition`). */
function locate(relativeBlocks: number[], current: number): [number, number] {
  let prev = 0;
  let next = 0;
  for (; next < relativeBlocks.length; next++) {
    if (relativeBlocks[next]! >= current) return [prev, next];
    prev = next;
  }
  return [next - 1, next - 1];
}

/**
 * Resolve a single decayed amount at `currentBlock` — the exact TypeScript translation of
 * `NonLinearDutchDecayLib.decay(curve, startAmount, decayStartBlock, currentBlock)`.
 */
export function decay(curve: DecayCurve, startAmount: bigint, decayStartBlock: number, currentBlock: number): bigint {
  if (curve.relativeAmounts.length > 16) throw new Error("InvalidDecayCurve");
  // Before decay begins, or a no-decay curve: hold at startAmount.
  if (decayStartBlock >= currentBlock || curve.relativeAmounts.length === 0) return startAmount;

  const blockDelta = currentBlock - decayStartBlock;
  // Segment from the anchor (block 0, startAmount) to the first curve point.
  if (curve.relativeBlocks[0]! > blockDelta) {
    return linearDecay(0, curve.relativeBlocks[0]!, blockDelta, startAmount, startAmount - curve.relativeAmounts[0]!);
  }
  const [prev, next] = locate(curve.relativeBlocks, blockDelta);
  const lastAmount = startAmount - curve.relativeAmounts[prev]!;
  const nextAmount = startAmount - curve.relativeAmounts[next]!;
  return linearDecay(curve.relativeBlocks[prev]!, curve.relativeBlocks[next]!, blockDelta, lastAmount, nextAmount);
}

/** Total output (summed over all legs) the swapper is owed at `blockNumber`, BEFORE any exclusivity handicap. */
export function resolveOutputOwedAtBlock(order: ParsedOrder, blockNumber: number): bigint {
  let total = 0n;
  for (const o of order.outputs) total += decay(o.curve, o.startAmount, order.decayStartBlock, blockNumber);
  return total;
}

/** Input amount the filler receives at `blockNumber` (constant for exact-in; decays for exact-out). */
export function resolveInputAtBlock(order: ParsedOrder, blockNumber: number): bigint {
  return decay(order.inputCurve, order.inputStartAmount, order.decayStartBlock, blockNumber);
}

/**
 * Whether `filler` is inside the exclusivity window for `order` at `blockNumber` — i.e. someone else is the
 * exclusive filler and the window (up to and including `decayStartBlock`) has not passed.
 */
export function inExclusivityWindow(order: ParsedOrder, filler: string, blockNumber: number): boolean {
  const excl = order.exclusiveFiller.toLowerCase();
  if (excl === "0x0000000000000000000000000000000000000000") return false;
  if (excl === filler.toLowerCase()) return false;
  return blockNumber <= order.decayStartBlock;
}

/** Sentinel for an order a non-exclusive filler CANNOT fill (strict exclusivity, override == 0, in-window). */
export const UNFILLABLE_EXCLUSIVE = -1n;

/**
 * Output `filler` must actually deliver at `blockNumber`, accounting for exclusivity. Equals the decayed owed for
 * the exclusive filler (or after the window); for a non-exclusive filler still inside the window it is scaled up
 * by `exclusivityOverrideBps` (rounded up), or {UNFILLABLE_EXCLUSIVE} under strict exclusivity.
 */
export function resolveOwedForFiller(order: ParsedOrder, filler: string, blockNumber: number): bigint {
  const owed = resolveOutputOwedAtBlock(order, blockNumber);
  if (!inExclusivityWindow(order, filler, blockNumber)) return owed;
  if (order.exclusivityOverrideBps === 0) return UNFILLABLE_EXCLUSIVE;
  return mulDivUp(owed, BPS + BigInt(order.exclusivityOverrideBps), BPS);
}

/** USD value (WAD) of `amount` base units of a token with `decimals`, priced at `priceWad` per full token. */
export function usdWad(amount: bigint, decimals: number, priceWad: bigint): bigint {
  return (amount * priceWad) / 10n ** BigInt(decimals);
}
