import { test } from "node:test";
import assert from "node:assert/strict";
import { SigningKey, Wallet } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";
import sdkPkg from "@uniswap/uniswapx-sdk";
import { createIngestor, parseDutchV3Order } from "../src/ingestor/index.js";
import { WETH, USDC, A } from "./fixtures.js";

const { V3DutchOrderBuilder } = sdkPkg;

function jsonResponse(orders: { orderHash: string; encodedOrder: string; signature: string }[]): Response {
  return { ok: true, status: 200, async json() { return { orders }; } } as unknown as Response;
}

test("poll dedupes already-seen order hashes across calls", async () => {
  let batch = [
    { orderHash: "0x1", encodedOrder: "0xa", signature: "0xs" },
    { orderHash: "0x2", encodedOrder: "0xb", signature: "0xs" },
  ];
  const ing = createIngestor({ ordersApi: "http://x", chainId: 8453, fetchFn: async () => jsonResponse(batch) });

  assert.equal((await ing.poll()).length, 2); // both fresh
  assert.equal((await ing.poll()).length, 0); // same batch, all seen
  batch = [...batch, { orderHash: "0x3", encodedOrder: "0xc", signature: "0xs" }];
  const fresh = await ing.poll();
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]!.orderHash, "0x3");
});

test("poll bounds the seen set and re-emits an evicted hash", async () => {
  // seenLimit 2: after seeing 0x1,0x2 then 0x3, 0x1 is evicted and re-emits if it reappears.
  let batch = [{ orderHash: "0x1", encodedOrder: "0xa", signature: "0xs" }];
  const ing = createIngestor({
    ordersApi: "http://x",
    chainId: 8453,
    seenLimit: 2,
    fetchFn: async () => jsonResponse(batch),
  });

  await ing.poll(); // seen: {0x1}
  batch = [{ orderHash: "0x2", encodedOrder: "0xb", signature: "0xs" }];
  await ing.poll(); // seen: {0x1,0x2}
  batch = [{ orderHash: "0x3", encodedOrder: "0xc", signature: "0xs" }];
  await ing.poll(); // adds 0x3 -> evicts oldest 0x1; seen: {0x2,0x3}
  batch = [{ orderHash: "0x1", encodedOrder: "0xa", signature: "0xs" }];
  const fresh = await ing.poll(); // 0x1 was evicted -> re-emitted
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]!.orderHash, "0x1");
});

test("poll throws on a non-ok response", async () => {
  const ing = createIngestor({
    ordersApi: "http://x",
    chainId: 8453,
    fetchFn: async () => ({ ok: false, status: 503 }) as unknown as Response,
  });
  await assert.rejects(() => ing.poll(), /orders API 503/);
});

test("parseDutchV3Order extracts input/output curves, exclusivity, and folds cosigner overrides", () => {
  const decayStartBlock = 2_000;
  const cosigner = Wallet.createRandom();
  const outCurve = { relativeBlocks: [4], relativeAmounts: [250n] };
  const cosignerData = {
    decayStartBlock,
    exclusiveFiller: A,
    exclusivityOverrideBps: BigNumber.from(25),
    inputOverride: BigNumber.from(0),
    outputOverrides: [BigNumber.from(1_010_000n)], // cosigner improves the output start amount (must be ≥ original)
  };
  const builder = new V3DutchOrderBuilder(8453, "0x000000008a8330B5d1F43A62Bf4C673A49f27ba0", "0x000000000022D473030F116dDEE9F6B43aC78BA3")
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
      minAmount: BigNumber.from(1_000_000n - 250n),
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

  assert.equal(parsed.decayStartBlock, decayStartBlock);
  assert.equal(parsed.decayEndBlock, decayStartBlock + 4); // start + max relativeBlock
  assert.equal(parsed.exclusiveFiller.toLowerCase(), A.toLowerCase());
  assert.equal(parsed.exclusivityOverrideBps, 25);
  assert.equal(parsed.tokenOut.toLowerCase(), WETH.toLowerCase());
  assert.equal(parsed.multiToken, false);
  assert.equal(parsed.outputs[0]!.startAmount, 1_010_000n); // cosigner override folded in
  assert.deepEqual(parsed.outputs[0]!.curve.relativeAmounts, [250n]);
  assert.equal(parsed.inputStartAmount, 1_000_000_000n); // inputOverride 0 ⇒ original
  assert.equal(parsed.inputCurve.relativeAmounts.length, 0);
});
