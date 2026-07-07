// Shared types across filler modules. See ../ARCHITECTURE.md §5.2.

export type Address = `0x${string}`;

/** WAD (1e18) USD price per full token, matching on-chain `TokenPrice.priceWad`. */
export interface TokenPrice {
  token: Address;
  priceWad: bigint;
}

/** Fresh price payloads + derived prices for a set of pool assets. */
export interface PayloadBundle {
  /** Pyth Lazer update blobs, ABI `bytes[]`. */
  pythUpdateData: `0x${string}`[];
  /** Signed CEX price data, ABI `IOracle.CexPriceData[]`. */
  cexPriceData: CexPriceData[];
  prices: TokenPrice[];
  /** ms since epoch when these payloads were fetched. */
  fetchedAtMs: number;
}

export interface CexPriceData {
  token: Address;
  priceInWad: bigint;
  timestamp: bigint; // unix ms, must match signed payload
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
}

/** A single hop in a Ryze swap path, mirroring `IMultiHopRouter.Hop`. */
export interface Hop {
  pool: Address;
  tokenIn: Address;
  tokenOut: Address;
}

/** Result of quoting a fill through Ryze, net of sessionized fees + WBR. */
export interface RyzeQuote {
  path: Hop[];
  amountIn: bigint;
  netAmountOut: bigint;
  /** For observability: sessionized slippage/WBF the quote already priced in. */
  sessionizedSlippage?: bigint;
  sessionizedWbf?: bigint;
  wbrCredit?: bigint;
}

/** A single resolved-baseline output leg of a Priority Order. */
export interface ParsedOutput {
  /** Raw order output token; `address(0)` is the UniswapX native-ETH sentinel. */
  token: Address;
  /**
   * Token the Ryze swap must actually deliver to source this leg: WETH for native-ETH outputs
   * (the executor unwraps and forwards ETH), otherwise identical to `token`.
   */
  settlementToken: Address;
  /** Baseline output amount (at effective priority fee 0). */
  amount: bigint;
  /** Per-wei output scaling factor for this leg (scales the amount UP with the effective priority fee). */
  mpsPerWei: bigint;
  recipient: Address;
}

/** A Priority Order decoded to the fields the quoter + strategy need (all amounts as native bigint). */
export interface ParsedOrder {
  orderHash: string;
  encodedOrder: `0x${string}`;
  signature: `0x${string}`;
  swapper: Address;
  /** Input the filler receives (exact-in baseline). */
  tokenIn: Address;
  amountIn: bigint;
  /** Non-zero for exact-output orders (input scales DOWN with priority fee); unsupported → skipped. */
  inputMpsPerWei: bigint;
  /** All output legs the fill must cover (main output + any fee outputs). */
  outputs: ParsedOutput[];
  /** Single settlement token the whole order sources through Ryze (all legs share it, native normalized to WETH). */
  tokenOut: Address;
  /** True if any leg is native-ETH (executor must unwrap WETH → ETH for the reactor). */
  hasNativeOutput: boolean;
  /** True if the legs span more than one settlement token (can't be sourced by a single swap → skipped). */
  multiToken: boolean;
  /** Priority-auction params. */
  baselinePriorityFeeWei: bigint;
  auctionTargetBlock: number;
  deadline: number;
}
