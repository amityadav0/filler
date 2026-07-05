import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MPS,
  mulDivUp,
  mulDivDown,
  scaleOutputUp,
  scaleInputDown,
  effectivePriorityFee,
  orderOutputAtBid,
  grossSpread,
} from "../src/strategy/economics.js";

test("mulDivUp / mulDivDown rounding", () => {
  assert.equal(mulDivDown(10n, 3n, 4n), 7n); // 30/4 = 7.5 -> 7
  assert.equal(mulDivUp(10n, 3n, 4n), 8n); //  30/4 = 7.5 -> 8
  assert.equal(mulDivUp(0n, 5n, 4n), 0n);
  assert.throws(() => mulDivDown(1n, 1n, 0n));
});

test("scaleOutputUp scales output up in the swapper's favour, rounding up", () => {
  // mpsPerWei = 0 -> unchanged
  assert.equal(scaleOutputUp(1000n, 0n, 5n), 1000n);
  // priorityFee * mpsPerWei = MPS -> exactly doubles
  assert.equal(scaleOutputUp(1000n, 1n, MPS), 2000n);
  // small factor rounds up
  assert.equal(scaleOutputUp(3n, 1n, 1n), 3n + 1n); // 3*(MPS+1)/MPS -> ceil = 4
});

test("scaleInputDown scales input down, clamps to 0 past MPS, rounds down", () => {
  assert.equal(scaleInputDown(1000n, 0n, 5n), 1000n);
  assert.equal(scaleInputDown(1000n, 1n, MPS), 0n); // factor == MPS -> 0
  assert.equal(scaleInputDown(1000n, 2n, MPS), 0n); // factor > MPS -> 0
  assert.equal(scaleInputDown(1000n, 1n, MPS / 2n), 500n); // half
});

test("effectivePriorityFee floors at zero below baseline", () => {
  assert.equal(effectivePriorityFee(100n, 40n), 60n);
  assert.equal(effectivePriorityFee(30n, 40n), 0n);
});

test("orderOutputAtBid combines baseline scaling with the effective fee", () => {
  // bid == baseline -> effective fee 0 -> baseline output
  assert.equal(orderOutputAtBid(1000n, 5n, 40n, 40n), 1000n);
  // bid one MPS-worth above baseline -> doubles
  assert.equal(orderOutputAtBid(1000n, 1n, 40n + MPS, 40n), 2000n);
});

test("grossSpread is ryzeOut minus owed", () => {
  assert.equal(grossSpread(1050n, 1000n), 50n);
  assert.equal(grossSpread(900n, 1000n), -100n);
});
