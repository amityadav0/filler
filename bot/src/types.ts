// Shared types across filler modules. See ../ARCHITECTURE.md §5.2.
//
// The bot fills exactly ONE order type: UniswapX **Dutch_V3** on Base (chainId 8453). All Priority-order
// concepts (priority-fee auctions, MPS scaling) are gone; a Dutch_V3 order's owed output is fixed by a
// block-based decay curve, and our only lever is whether/when to fill (see strategy/economics).

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

/**
 * A UniswapX V3 nonlinear-Dutch decay curve, mirroring the SDK's `NonlinearDutchDecay` (and on-chain
 * `NonlinearDutchDecayLib`). `relativeBlocks[i]` is a block offset from the order's `decayStartBlock`;
 * `relativeAmounts[i]` is the amount **subtracted** from `startAmount` at that offset (so the resolved amount is
 * `startAmount - relativeAmounts[i]`). Between points the amount is piecewise-linear; before the first point it
 * holds at `startAmount`, after the last it holds at `startAmount - relativeAmounts[last]`. An empty curve means
 * no decay (constant `startAmount`) — the common case for the input leg of an exact-in order.
 */
export interface DecayCurve {
  relativeBlocks: number[];
  relativeAmounts: bigint[];
}

/** A single output leg of a Dutch_V3 order. */
export interface ParsedOutput {
  /** Raw order output token; `address(0)` is the UniswapX native-ETH sentinel. */
  token: Address;
  /**
   * Token the Ryze swap must actually deliver to source this leg: WETH for native-ETH outputs
   * (the executor unwraps and forwards ETH), otherwise identical to `token`.
   */
  settlementToken: Address;
  /** Output amount at `decayStartBlock` (already folded with any cosigner `outputOverride`). Decays DOWN. */
  startAmount: bigint;
  /** Block-decay curve for this leg (relative to the order's `decayStartBlock`). */
  curve: DecayCurve;
  recipient: Address;
}

/** A Dutch_V3 order decoded to the fields the quoter + strategy need (all amounts as native bigint). */
export interface ParsedOrder {
  orderHash: string;
  encodedOrder: `0x${string}`;
  signature: `0x${string}`;
  swapper: Address;
  /** Input the filler receives. */
  tokenIn: Address;
  /** Input amount at `decayStartBlock` (folded with any cosigner `inputOverride`). Constant for exact-in orders;
   *  decays UP for exact-out. Resolve at the fill block via `resolveInputAtBlock`. */
  inputStartAmount: bigint;
  /** Block-decay curve for the input leg (empty ⇒ constant input, the exact-in case). */
  inputCurve: DecayCurve;
  /** All output legs the fill must cover (main output + any fee outputs). */
  outputs: ParsedOutput[];
  /** Single settlement token the whole order sources through Ryze (all legs share it, native normalized to WETH). */
  tokenOut: Address;
  /** True if any leg is native-ETH (executor must unwrap WETH → ETH for the reactor). */
  hasNativeOutput: boolean;
  /** True if the legs span more than one settlement token (can't be sourced by a single swap → skipped). */
  multiToken: boolean;
  /** Cosigner-set block at which decay begins; also the exclusivity-window end (see economics). */
  decayStartBlock: number;
  /** Last block of the decay curve (`decayStartBlock` + max relativeBlock across all legs); owed is flat after. */
  decayEndBlock: number;
  /** Exclusive filler for the exclusivity window (`address(0)` ⇒ open from the start). */
  exclusiveFiller: Address;
  /** Output scale-up (bps) a non-exclusive filler pays while `block <= decayStartBlock`; 0 ⇒ strict exclusivity. */
  exclusivityOverrideBps: number;
  /** Order deadline (unix seconds). */
  deadline: number;
}
