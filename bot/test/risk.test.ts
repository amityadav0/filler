import { test } from "node:test";
import assert from "node:assert/strict";
import { createExposureTracker, createGasBudget } from "../src/strategy/risk.js";

const WETH = "0x4200000000000000000000000000000000000006";

test("exposure tracker enforces a per-token cap", () => {
  const ex = createExposureTracker(100n);
  assert.equal(ex.canAdd(WETH, 60n), true);
  ex.add(WETH, 60n);
  assert.equal(ex.current(WETH), 60n);
  assert.equal(ex.canAdd(WETH, 40n), true);
  assert.equal(ex.canAdd(WETH, 41n), false); // 60+41 > 100
  ex.release(WETH, 60n);
  assert.equal(ex.current(WETH), 0n);
  assert.equal(ex.canAdd(WETH, 100n), true);
});

test("exposure tracker with cap 0 is disabled", () => {
  const ex = createExposureTracker(0n);
  assert.equal(ex.canAdd(WETH, 10n ** 30n), true);
});

test("exposure tracker keys case-insensitively", () => {
  const ex = createExposureTracker(100n);
  ex.add(WETH.toUpperCase(), 60n);
  assert.equal(ex.current(WETH.toLowerCase()), 60n);
});

test("gas budget enforces a sliding 1h cap and prunes old spend", () => {
  let clock = 1_000_000;
  const gb = createGasBudget(100n, () => clock);
  assert.equal(gb.canSpend(60n), true);
  gb.record(60n);
  assert.equal(gb.spentLastHour(), 60n);
  assert.equal(gb.canSpend(41n), false); // 60+41 > 100
  assert.equal(gb.canSpend(40n), true);
  // advance > 1h: old spend falls out of the window
  clock += 3_600_001;
  assert.equal(gb.spentLastHour(), 0n);
  assert.equal(gb.canSpend(100n), true);
});

test("gas budget with cap 0 is disabled", () => {
  const gb = createGasBudget(0n, () => 0);
  assert.equal(gb.canSpend(10n ** 30n), true);
});
