// submitter (M3 shadow / M4 live): encode fillData + build the executor.execute tx.
// In shadow mode the tx is BUILT and returned but never sent. Live sending is gated behind `send: true` (M4).
import { AbiCoder, Interface, type TransactionRequest, type Signer } from "ethers";
import type { Address, CexPriceData, Hop } from "../types.js";

/** ABI-type string for `RyzeUniswapXExecutor.FillData`. */
const FILL_DATA_TYPE =
  "tuple(" +
  "tuple(address pool, address tokenIn, address tokenOut)[] path, " +
  "uint256 minAmountOut, " +
  "uint256 deadline, " +
  "bytes[] pythUpdateData, " +
  "tuple(address token, uint256 priceInWad, uint256 timestamp, uint8 v, bytes32 r, bytes32 s)[] cexPriceData, " +
  "uint256 pythFeeWei)";

const EXECUTOR_ABI = ["function execute(tuple(bytes order, bytes sig) order, bytes fillData)"];

/** A chosen priority-fee bid for an order. Populated by the strategy. */
export interface Bid {
  maxPriorityFeePerGasWei: bigint;
  expectedProfitOut: bigint;
}

export interface FillTxInputs {
  encodedOrder: `0x${string}`;
  signature: `0x${string}`;
  path: Hop[];
  /** Router-side slippage floor (≥ what we owe the swapper). */
  minAmountOut: bigint;
  deadline: number;
  pythUpdateData: `0x${string}`[];
  cexPriceData: CexPriceData[];
  /** Native Pyth verification fee to forward (= pythLazer.verification_fee() × non-empty pyth blobs). Exact. */
  pythFeeWei: bigint;
  bidWei: bigint;
  baseFeeWei: bigint;
  gasLimit: bigint;
}

export interface FillOutcome {
  /** The built, ready-to-send transaction. */
  tx: TransactionRequest;
  /** Whether the tx was broadcast (false in shadow mode). */
  sent: boolean;
  txHash?: `0x${string}`;
}

export interface Submitter {
  /** Build the fill tx; broadcasts only when `send` is true (M4) and a signer is configured. */
  submit(inputs: FillTxInputs, send?: boolean): Promise<FillOutcome>;
}

/** ABI-encode `RyzeUniswapXExecutor.FillData`. */
export function encodeFillData(inputs: FillTxInputs): string {
  const path = inputs.path.map((h) => [h.pool, h.tokenIn, h.tokenOut]);
  const cex = inputs.cexPriceData.map((c) => [c.token, c.priceInWad, c.timestamp, c.v, c.r, c.s]);
  return AbiCoder.defaultAbiCoder().encode(
    [FILL_DATA_TYPE],
    [[path, inputs.minAmountOut, inputs.deadline, inputs.pythUpdateData, cex, inputs.pythFeeWei]],
  );
}

/** Build the EIP-1559 `executor.execute(order, fillData)` transaction. */
export function buildFillTx(executor: Address, chainId: number, inputs: FillTxInputs): TransactionRequest {
  const iface = new Interface(EXECUTOR_ABI);
  const fillData = encodeFillData(inputs);
  const data = iface.encodeFunctionData("execute", [[inputs.encodedOrder, inputs.signature], fillData]);
  return {
    to: executor,
    data,
    // Attach the Pyth verification fee; execute() is payable and the executor forwards it to the router.
    value: inputs.pythFeeWei,
    chainId,
    type: 2,
    maxPriorityFeePerGas: inputs.bidWei,
    maxFeePerGas: inputs.baseFeeWei + inputs.bidWei,
    gasLimit: inputs.gasLimit,
  };
}

export interface SubmitterOptions {
  executor: Address;
  chainId: number;
  /** Required only for live sending (M4); omitted in shadow mode. */
  signer?: Signer;
}

export function createSubmitter(opts: SubmitterOptions): Submitter {
  return {
    async submit(inputs: FillTxInputs, send = false): Promise<FillOutcome> {
      const tx = buildFillTx(opts.executor, opts.chainId, inputs);
      if (!send) return { tx, sent: false };
      if (!opts.signer) throw new Error("live send requested but no signer configured");
      const resp = await opts.signer.sendTransaction(tx);
      return { tx, sent: true, txHash: resp.hash as `0x${string}` };
    },
  };
}
