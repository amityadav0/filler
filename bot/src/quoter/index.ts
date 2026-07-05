// quoter (M2): best Ryze path via WeightedPoolQueries.querySwapExactIn eth_call with from = executor.
//
// The query is session-aware: TSP keys sessions by (trader, pool) and the trader is the router's msg.sender =
// our executor. So the quote must be taken with `from = executor` (staticCall override) for the returned
// sessionized slippage/WBF to match execution. `amountCalculated` already includes any WBR credit.
import { Contract, type Provider } from "ethers";
import type { Address, PayloadBundle, RyzeQuote, Hop } from "../types.js";
import type { PoolConfig } from "../config.js";

/// Human-readable ABI for `WeightedPoolQueries.querySwapExactIn`. Struct field names are cosmetic — ethers
/// encodes by position; the shape mirrors ryze-contracts `IWeightedPoolQueries.SwapResult` exactly.
const QUERIES_ABI = [
  "function querySwapExactIn(" +
    "address pool, address tokenIn, address tokenOut, uint256 amountIn, " +
    "tuple(address token, uint256 priceWad)[] tokenPrices, bool isIntentSwap" +
    ") view returns (tuple(" +
    "uint256 amountCalculated, " +
    "tuple(" +
    "tuple(address token, uint256 amount) swapFee, " +
    "tuple(address token, uint256 amount) takerFee, " +
    "tuple(address token, uint256 amount) wbfFee, " +
    "tuple(address token, uint256 amount) slippageFee, " +
    "tuple(address token, uint256 amount) wbrFee) feeDetails, " +
    "uint256 priceImpact, uint256 effectivePrice) result)",
];

export interface Quoter {
  /** Net Ryze output (incl. sessionized fees + WBR) for swapping amountIn of tokenIn → tokenOut. */
  quoteExactIn(tokenIn: Address, tokenOut: Address, amountIn: bigint, payloads: PayloadBundle): Promise<RyzeQuote | null>;
}

export interface QuoterOptions {
  provider: Provider;
  /** WeightedPoolQueries address. */
  queriesAddress: Address;
  /** Executor address — used as the `from` override so the quote matches the executor's TSP session. */
  executorAddress: Address;
  pools: PoolConfig[];
}

interface QuerySwapResult {
  amountCalculated: bigint;
  feeDetails: {
    swapFee: { token: string; amount: bigint };
    takerFee: { token: string; amount: bigint };
    wbfFee: { token: string; amount: bigint };
    slippageFee: { token: string; amount: bigint };
    wbrFee: { token: string; amount: bigint };
  };
  priceImpact: bigint;
  effectivePrice: bigint;
}

/** Find a single pool holding both tokens (single-hop). Multi-hop path search is a later enhancement. */
export function findSingleHop(pools: PoolConfig[], tokenIn: Address, tokenOut: Address): Hop | null {
  const a = tokenIn.toLowerCase();
  const b = tokenOut.toLowerCase();
  for (const p of pools) {
    const toks = p.tokens.map((t) => t.toLowerCase());
    if (toks.includes(a) && toks.includes(b)) {
      return { pool: p.pool, tokenIn, tokenOut };
    }
  }
  return null;
}

export function createQuoter(opts: QuoterOptions): Quoter {
  const queries = new Contract(opts.queriesAddress, QUERIES_ABI, opts.provider);

  return {
    async quoteExactIn(
      tokenIn: Address,
      tokenOut: Address,
      amountIn: bigint,
      payloads: PayloadBundle,
    ): Promise<RyzeQuote | null> {
      const hop = findSingleHop(opts.pools, tokenIn, tokenOut);
      if (!hop) return null;

      const priceOf = (t: Address) => payloads.prices.find((p) => p.token.toLowerCase() === t.toLowerCase());
      const pIn = priceOf(tokenIn);
      const pOut = priceOf(tokenOut);
      if (!pIn || !pOut) return null; // SmartShield pools require both legs (length ≥ 2)

      const tokenPrices = [
        { token: pIn.token, priceWad: pIn.priceWad },
        { token: pOut.token, priceWad: pOut.priceWad },
      ];

      const res = (await queries.querySwapExactIn.staticCall(
        hop.pool,
        tokenIn,
        tokenOut,
        amountIn,
        tokenPrices,
        false, // isIntentSwap: direct swaps avoid the intent fee (OQ-3)
        { from: opts.executorAddress },
      )) as unknown as QuerySwapResult;

      return {
        path: [hop],
        amountIn,
        netAmountOut: res.amountCalculated,
        sessionizedSlippage: res.feeDetails.slippageFee.amount,
        sessionizedWbf: res.feeDetails.wbfFee.amount,
        wbrCredit: res.feeDetails.wbrFee.amount,
      };
    },
  };
}
