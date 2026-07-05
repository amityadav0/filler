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

/** A Priority Order decoded to the fields the quoter + strategy need (all amounts as native bigint). */
export interface ParsedOrder {
  orderHash: string;
  encodedOrder: `0x${string}`;
  signature: `0x${string}`;
  swapper: Address;
  /** Input the filler receives (exact-in baseline). */
  tokenIn: Address;
  amountIn: bigint;
  inputMpsPerWei: bigint;
  /** Primary output owed to the swapper. */
  tokenOut: Address;
  baselineAmountOut: bigint;
  outputMpsPerWei: bigint;
  outputRecipient: Address;
  /** Priority-auction params. */
  baselinePriorityFeeWei: bigint;
  auctionTargetBlock: number;
  deadline: number;
}
