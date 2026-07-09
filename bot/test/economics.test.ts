import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BPS,
  mulDivUp,
  decay,
  resolveOutputOwedAtBlock,
  resolveInputAtBlock,
  inExclusivityWindow,
  resolveOwedForFiller,
  usdWad,
  UNFILLABLE_EXCLUSIVE,
} from "../src/strategy/economics.js";
import { dutchOrder, output, A, OTHER, ZERO } from "./fixtures.js";
import type { DecayCurve } from "../src/types.js";

test("mulDivUp rounds up; zero product stays zero", () => {
  assert.equal(mulDivUp(10n, 3n, 4n), 8n); // 30/4 = 7.5 -> 8
  assert.equal(mulDivUp(0n, 5n, 4n), 0n);
  assert.throws(() => mulDivUp(1n, 1n, 0n));
});

// Single linear segment: startAmount 1000 decays by 100 over 10 blocks from decayStartBlock 100.
const curve: DecayCurve = { relativeBlocks: [10], relativeAmounts: [100n] };

test("decay: clamped to startAmount at/before decayStartBlock", () => {
  assert.equal(decay(curve, 1000n, 100, 99), 1000n);
  assert.equal(decay(curve, 1000n, 100, 100), 1000n);
});

test("decay: linear interpolation mid-curve (floor toward startAmount)", () => {
  assert.equal(decay(curve, 1000n, 100, 105), 950n); // halfway: 1000 - 100*5/10
  assert.equal(decay(curve, 1000n, 100, 101), 990n); // 1000 - 100*1/10
});

test("decay: clamped to end amount at and after the last point", () => {
  assert.equal(decay(curve, 1000n, 100, 110), 900n);
  assert.equal(decay(curve, 1000n, 100, 130), 900n);
});

test("decay: empty curve is constant", () => {
  assert.equal(decay({ relativeBlocks: [], relativeAmounts: [] }, 1000n, 100, 200), 1000n);
});

test("resolveOutputOwedAtBlock / resolveInputAtBlock apply the curve per leg", () => {
  const order = dutchOrder({
    decayStartBlock: 100,
    outputs: [output({ startAmount: 1000n, curve })],
    inputStartAmount: 5_000n,
    inputCurve: { relativeBlocks: [], relativeAmounts: [] }, // exact-in: input constant
  });
  assert.equal(resolveOutputOwedAtBlock(order, 105), 950n);
  assert.equal(resolveInputAtBlock(order, 105), 5_000n);
});

test("exclusivity window is only for a foreign filler up to decayStartBlock", () => {
  const order = dutchOrder({ decayStartBlock: 100, exclusiveFiller: OTHER, exclusivityOverrideBps: 25 });
  assert.equal(inExclusivityWindow(order, A, 100), true); // A is not the exclusive filler, in window
  assert.equal(inExclusivityWindow(order, A, 101), false); // past the window
  assert.equal(inExclusivityWindow(order, OTHER, 100), false); // the exclusive filler has rights
  assert.equal(inExclusivityWindow(dutchOrder({ exclusiveFiller: ZERO }), A, 0), false); // open order
});

test("resolveOwedForFiller: foreign filler pays the override in-window, nothing after", () => {
  const order = dutchOrder({
    decayStartBlock: 100,
    exclusiveFiller: OTHER,
    exclusivityOverrideBps: 25,
    outputs: [output({ startAmount: 1000n, curve })],
  });
  // In-window: owed 1000 scaled up 25bps, rounded up: ceil(1000*10025/10000) = 1003.
  assert.equal(resolveOwedForFiller(order, A, 100), 1003n);
  // The exclusive filler owes the plain decayed amount even in-window.
  assert.equal(resolveOwedForFiller(order, OTHER, 100), 1000n);
  // Past the window: no handicap, decayed value.
  assert.equal(resolveOwedForFiller(order, A, 105), 950n);
});

test("resolveOwedForFiller: strict exclusivity (override 0) is unfillable for a foreign filler in-window", () => {
  const strict = dutchOrder({ decayStartBlock: 100, exclusiveFiller: OTHER, exclusivityOverrideBps: 0 });
  assert.equal(resolveOwedForFiller(strict, A, 100), UNFILLABLE_EXCLUSIVE);
  assert.notEqual(resolveOwedForFiller(strict, A, 101), UNFILLABLE_EXCLUSIVE); // fillable after window
});

test("BPS constant + usdWad", () => {
  assert.equal(BPS, 10_000n);
  // 2 full tokens (6 dec) at $1500 → $3000 WAD.
  assert.equal(usdWad(2_000_000n, 6, 1500n * 10n ** 18n), 3000n * 10n ** 18n);
});
