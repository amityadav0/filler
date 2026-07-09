// Shared Dutch_V3 test fixtures. Not a *.test.ts file, so the node test runner does not execute it directly.
import type { Address, DecayCurve, ParsedOrder, ParsedOutput } from "../src/types.js";

export const A: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const OTHER: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const USDC: Address = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA";
export const WETH: Address = "0x4200000000000000000000000000000000000006";

export const NO_DECAY: DecayCurve = { relativeBlocks: [], relativeAmounts: [] };

export function output(over: Partial<ParsedOutput> = {}): ParsedOutput {
  return {
    token: WETH,
    settlementToken: WETH,
    startAmount: 1_000_000n,
    curve: NO_DECAY,
    recipient: A,
    ...over,
  };
}

/** A Dutch_V3 order: single WETH output, no decay, no exclusivity, decayStart at block 0 (owed = startAmount). */
export function dutchOrder(over: Partial<ParsedOrder> = {}): ParsedOrder {
  return {
    orderHash: "0xorderhash0000",
    encodedOrder: "0xabcd",
    signature: "0xsig",
    swapper: A,
    tokenIn: USDC,
    inputStartAmount: 1_000_000_000n,
    inputCurve: NO_DECAY,
    outputs: [output()],
    tokenOut: WETH,
    hasNativeOutput: false,
    multiToken: false,
    decayStartBlock: 0,
    decayEndBlock: 0,
    exclusiveFiller: ZERO,
    exclusivityOverrideBps: 0,
    deadline: 0,
    ...over,
  };
}
