import { test } from "node:test";
import assert from "node:assert/strict";
import { SigningKey, Wallet, ZeroAddress } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";
import sdkPkg from "@uniswap/uniswapx-sdk";
import { resolveOutputOwedAtBlock, resolveInputAtBlock } from "../src/strategy/economics.js";
import { parseDutchV3Order } from "../src/ingestor/index.js";
import { dutchOrder, output, WETH, USDC, A } from "./fixtures.js";
import type { DecayCurve } from "../src/types.js";

const { V3DutchOrderBuilder } = sdkPkg;
const REACTOR = "0x000000008a8330B5d1F43A62Bf4C673A49f27ba0";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

test("resolveOutputOwedAtBlock sums every leg (main + fee), each with its own curve", () => {
  const mainCurve: DecayCurve = { relativeBlocks: [10], relativeAmounts: [100n] };
  const order = dutchOrder({
    decayStartBlock: 100,
    outputs: [
      output({ startAmount: 1_000n, curve: mainCurve }), // 1000 → 950 at block 105
      output({ startAmount: 200n, curve: { relativeBlocks: [], relativeAmounts: [] }, recipient: USDC }), // fixed fee
    ],
  });
  assert.equal(resolveOutputOwedAtBlock(order, 100), 1_200n); // 1000 + 200
  assert.equal(resolveOutputOwedAtBlock(order, 105), 1_150n); // 950 + 200
});

// Offline parity: our resolver must match the SDK's own resolve() to the wei (the SDK mirrors on-chain).
test("resolver matches the SDK resolve() for a locally-built cosigned order", () => {
  const decayStartBlock = 1000;
  const cosigner = Wallet.createRandom();
  const outCurve = { relativeBlocks: [2, 6], relativeAmounts: [40n, 120n] }; // two-point nonlinear curve
  const cosignerData = {
    decayStartBlock,
    exclusiveFiller: ZeroAddress,
    exclusivityOverrideBps: BigNumber.from(0),
    inputOverride: BigNumber.from(0),
    outputOverrides: [BigNumber.from(0)],
  };
  const builder = new V3DutchOrderBuilder(8453, REACTOR, PERMIT2)
    .cosigner(cosigner.address)
    .startingBaseFee(BigNumber.from(0))
    .input({
      token: USDC,
      startAmount: BigNumber.from(1_000_000_000n),
      curve: { relativeBlocks: [], relativeAmounts: [] },
      maxAmount: BigNumber.from(1_000_000_000n),
      adjustmentPerGweiBaseFee: BigNumber.from(0),
    })
    .output({
      token: WETH,
      startAmount: BigNumber.from(1_000_000n),
      curve: outCurve,
      recipient: A,
      minAmount: BigNumber.from(1_000_000n - 120n),
      adjustmentPerGweiBaseFee: BigNumber.from(0),
    })
    .deadline(Math.floor(Date.now() / 1000) + 3600)
    .swapper(A)
    .nonce(BigNumber.from(1));
  const unsigned = builder.buildPartial();
  const cosignature = new SigningKey(cosigner.privateKey).sign(unsigned.cosignatureHash(cosignerData)).serialized;
  const order = builder.cosignerData(cosignerData).cosignature(cosignature).build();

  const parsed = parseDutchV3Order(
    { orderHash: order.hash(), encodedOrder: order.serialize() as `0x${string}`, signature: "0x" },
    8453,
    WETH,
  );

  for (const blk of [decayStartBlock - 1, decayStartBlock, decayStartBlock + 1, decayStartBlock + 3, decayStartBlock + 6, decayStartBlock + 20]) {
    const sdkRes = order.resolve({ currentBlock: blk });
    const sdkOut = sdkRes.outputs.reduce((s, o) => s + BigInt(o.amount.toString()), 0n);
    assert.equal(resolveOutputOwedAtBlock(parsed, blk), sdkOut, `output @ ${blk}`);
    assert.equal(resolveInputAtBlock(parsed, blk), BigInt(sdkRes.input.amount.toString()), `input @ ${blk}`);
  }
});
