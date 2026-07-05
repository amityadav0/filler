import { test } from "node:test";
import assert from "node:assert/strict";
import { findSingleHop } from "../src/quoter/index.js";
import type { PoolConfig } from "../src/config.js";
import type { Address } from "../src/types.js";

const USDC: Address = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA";
const WETH: Address = "0x4200000000000000000000000000000000000006";
const DAI: Address = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb";

const pools: PoolConfig[] = [
  {
    pool: "0xpool1111111111111111111111111111111111111" as Address,
    tokens: [USDC, WETH],
    feedIds: {},
    bandLimits: { maxNotionalUsdWad: "0" },
  },
];

test("findSingleHop matches a pool holding both tokens (case-insensitive)", () => {
  const hop = findSingleHop(pools, USDC.toLowerCase() as Address, WETH);
  assert.ok(hop);
  assert.equal(hop.pool, pools[0]!.pool);
  assert.equal(hop.tokenIn, USDC.toLowerCase());
  assert.equal(hop.tokenOut, WETH);
});

test("findSingleHop returns null when no pool spans the pair", () => {
  assert.equal(findSingleHop(pools, USDC, DAI), null);
});
