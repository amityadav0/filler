import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MPS,
  sumBaseOutput,
  outputWeight,
  totalOwedAtEffFee,
  effFeeForExtraOutWeighted,
  type OutputLeg,
} from "../src/strategy/economics.js";

const legs: OutputLeg[] = [
  { amount: 1_000_000n, mpsPerWei: 1n },
  { amount: 200_000n, mpsPerWei: 0n }, // fixed fee leg, does not scale
];

test("sumBaseOutput adds all legs", () => {
  assert.equal(sumBaseOutput(legs), 1_200_000n);
  assert.equal(sumBaseOutput([]), 0n);
});

test("outputWeight is Σ amount*mpsPerWei", () => {
  assert.equal(outputWeight(legs), 1_000_000n); // 1e6*1 + 2e5*0
});

test("totalOwedAtEffFee scales each leg by its own factor, rounding up", () => {
  // effFee 0 -> baseline sum
  assert.equal(totalOwedAtEffFee(legs, 0n), 1_200_000n);
  // effFee = MPS worth on leg0 (mps 1) doubles leg0 only: 2e6 + 2e5
  assert.equal(totalOwedAtEffFee(legs, MPS), 2_000_000n + 200_000n);
});

test("effFeeForExtraOutWeighted inverts the aggregate slope, rounding up", () => {
  assert.equal(effFeeForExtraOutWeighted(0n, 100n), 0n); // no scaling weight
  assert.equal(effFeeForExtraOutWeighted(1_000_000n, 0n), 0n);
  // want +60 extra with weight 1e6: effFee = ceil(60*MPS/1e6) = ceil(600) = 600
  assert.equal(effFeeForExtraOutWeighted(1_000_000n, 60n), 600n);
  // and applying it delivers at least the target extra
  assert.ok(totalOwedAtEffFee(legs, 600n) - 1_200_000n >= 60n);
});
