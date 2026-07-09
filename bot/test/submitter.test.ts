import { test } from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, Interface } from "ethers";
import { encodeFillData, buildFillTx, type FillTxInputs } from "../src/submitter/index.js";
import type { Address, CexPriceData, Hop } from "../src/types.js";

const EXECUTOR: Address = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0";
const POOL: Address = "0xcccccccccccccccccccccccccccccccccccccccc";
const USDC: Address = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA";
const WETH: Address = "0x4200000000000000000000000000000000000006";

const FILL_DATA_TYPE =
  "tuple(" +
  "tuple(address pool, address tokenIn, address tokenOut)[] path, " +
  "uint256 minAmountOut, uint256 deadline, bytes[] pythUpdateData, " +
  "tuple(address token, uint256 priceInWad, uint256 timestamp, uint8 v, bytes32 r, bytes32 s)[] cexPriceData, " +
  "uint256 pythFeeWei)";

const b32 = ("0x" + "11".repeat(32)) as `0x${string}`;

function inputs(): FillTxInputs {
  const path: Hop[] = [{ pool: POOL, tokenIn: USDC, tokenOut: WETH }];
  const cex: CexPriceData[] = [{ token: USDC, priceInWad: 1n, timestamp: 2n, v: 27, r: b32, s: b32 }];
  return {
    encodedOrder: "0xdeadbeef",
    signature: "0xc0ffee",
    path,
    minAmountOut: 123n,
    deadline: 999,
    pythUpdateData: ["0xabcd"],
    cexPriceData: cex,
    pythFeeWei: 3n,
    inclusionPriorityFeeWei: 500n,
    baseFeeWei: 1_000n,
    gasLimit: 350_000n,
  };
}

test("encodeFillData round-trips through the FillData tuple", () => {
  const encoded = encodeFillData(inputs());
  const [decoded] = AbiCoder.defaultAbiCoder().decode([FILL_DATA_TYPE], encoded);
  assert.equal(decoded.path[0].pool.toLowerCase(), POOL.toLowerCase());
  assert.equal(decoded.path[0].tokenOut.toLowerCase(), WETH.toLowerCase());
  assert.equal(decoded.minAmountOut, 123n);
  assert.equal(decoded.deadline, 999n);
  assert.equal(decoded.pythUpdateData[0], "0xabcd");
  assert.equal(decoded.cexPriceData[0].priceInWad, 1n);
  assert.equal(decoded.cexPriceData[0].v, 27n);
  assert.equal(decoded.pythFeeWei, 3n);
});

test("buildFillTx sets EIP-1559 fields and encodes execute(order, fillData)", () => {
  const tx = buildFillTx(EXECUTOR, 8453, inputs());
  assert.equal((tx.to as string).toLowerCase(), EXECUTOR.toLowerCase());
  assert.equal(tx.type, 2);
  assert.equal(tx.maxPriorityFeePerGas, 500n);
  assert.equal(tx.maxFeePerGas, 2_500n); // 2×baseFee headroom + bid (unused portion refunded under EIP-1559)
  assert.equal(tx.gasLimit, 350_000n);
  assert.equal(tx.chainId, 8453);
  assert.equal(tx.value, 3n); // Pyth verification fee attached

  const iface = new Interface(["function execute(tuple(bytes order, bytes sig) order, bytes fillData)"]);
  const parsed = iface.parseTransaction({ data: tx.data as string });
  assert.ok(parsed);
  assert.equal(parsed.args.order.order, "0xdeadbeef");
  assert.equal(parsed.args.order.sig, "0xc0ffee");
});
