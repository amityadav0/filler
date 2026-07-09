// Shared per-order evaluation used by both the shadow (build-only) and live (send) loops:
// parse → resolve input at block → payloads → quote → prices/decimals → fill decision → pyth fee.
// Lifecycle concerns (exposure holds, decay/exclusivity timing, sending, receipts) stay in the loops.
import type { PayloadService } from "./payloads/index.js";
import type { Quoter } from "./quoter/index.js";
import type { Metrics } from "./metrics/index.js";
import type { TokenMeta } from "./chain/tokens.js";
import type { OpenOrder } from "./ingestor/index.js";
import { parseDutchV3Order } from "./ingestor/index.js";
import { decideFill, type FillContext, type FillDecision } from "./strategy/index.js";
import { resolveInputAtBlock, usdWad } from "./strategy/economics.js";
import type { Address, ParsedOrder, PayloadBundle, RyzeQuote } from "./types.js";
import { allPoolAssets, type FillerConfig } from "./config.js";

export interface PrepareDeps {
  config: FillerConfig;
  payloads: PayloadService;
  quoter: Quoter;
  tokenMeta: TokenMeta;
  metrics: Metrics;
  /** Order decoder; defaults to the SDK-backed parseDutchV3Order (injectable for tests). */
  parse?: (order: OpenOrder, chainId: number, wethAddress: Address) => ParsedOrder;
  log?: (msg: string) => void;
}

export interface PreparedFill {
  parsed: ParsedOrder;
  payloads: PayloadBundle;
  quote: RyzeQuote;
  ctx: FillContext;
  decision: FillDecision;
  /** Input amount resolved at the decision block (what the executor receives and the quote was taken for). */
  amountIn: bigint;
  /** Native fee to attach: verification_fee × non-empty pyth blobs (per-blob billing — see comment below). */
  pythFeeWei: bigint;
}

/** verification_fee × non-empty blobs. The oracle bills per verifyUpdate call (one per non-empty updateData
 *  element, NOT per feed inside the blob — ryze-contracts PythProOracle.sol:344-352); we send one bundled blob.
 *  Excess is not refunded, so never overpay. */
export function pythFeeFor(config: FillerConfig, bundle: PayloadBundle): bigint {
  const nonEmptyBlobs = bundle.pythUpdateData.filter((b) => b && b !== "0x").length;
  return BigInt(config.oracle.pythVerificationFeeWei) * BigInt(nonEmptyBlobs);
}

/**
 * Evaluate one open order end-to-end at `blockNumber` (the intended fill block). Returns null when the order is
 * skipped for a *policy* reason (no path, no spread, caps, exclusivity, …) — the skip is logged and counted here.
 * Unexpected failures (RPC, payload feeds) throw; the calling loop owns error accounting.
 */
export async function prepareFill(
  deps: PrepareDeps,
  order: OpenOrder,
  baseFeeWei: bigint,
  blockNumber: number,
): Promise<PreparedFill | null> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const parse = deps.parse ?? parseDutchV3Order;
  const { config } = deps;
  const wethAddr = config.addresses.weth as Address;
  const weth = config.addresses.weth.toLowerCase();

  let parsed: ParsedOrder;
  try {
    parsed = parse(order, config.chainId, wethAddr);
  } catch (err) {
    deps.metrics.inc("orders.parseError");
    log(`skip ${order.orderHash.slice(0, 10)}: parse error: ${(err as Error).message}`);
    return null;
  }

  // Input the executor will receive at the fill block (constant for exact-in; decays for exact-out).
  const amountIn = resolveInputAtBlock(parsed, blockNumber);

  // Payloads must cover EVERY asset with a subscribed Pyth feed, not just the fill pair: the Lazer blob bundles
  // all subscribed feeds, and PythProOracle._parseAndStore reverts (PriceOracle_InvalidCexPrice) for any fresh
  // feed lacking a matching signed CEX price. Same reason the limit-order-bot sends ALL cached prices
  // (GetAllPriceForAmm). This also guarantees the WETH price is present for USD gas costing.
  const payloads = await deps.payloads.getPayloads(allPoolAssets(config));
  const quote = await deps.quoter.quoteExactIn(parsed.tokenIn, parsed.tokenOut, amountIn, payloads);
  deps.metrics.inc("orders.quoted");
  if (!quote) {
    deps.metrics.inc("orders.noPath");
    return null;
  }

  const priceOf = (t: Address) => payloads.prices.find((p) => p.token.toLowerCase() === t.toLowerCase())?.priceWad;
  const priceInWad = priceOf(parsed.tokenIn);
  const priceOutWad = priceOf(parsed.tokenOut);
  if (priceInWad === undefined || priceOutWad === undefined) {
    deps.metrics.inc("orders.noPrice");
    return null;
  }
  const nativePriceWad = payloads.prices.find((p) => p.token.toLowerCase() === weth)?.priceWad;

  const [decimalsIn, decimalsOut] = await Promise.all([
    deps.tokenMeta.decimalsOf(parsed.tokenIn),
    deps.tokenMeta.decimalsOf(parsed.tokenOut),
  ]);

  const ctx: FillContext = {
    filler: config.addresses.executor,
    priceOutWad,
    decimalsOut,
    nativePriceWad,
    gasEstimate: BigInt(config.strategy.gasEstimate),
    baseFeeWei,
    inclusionPriorityFeeWei: BigInt(config.strategy.maxInclusionPriorityFeeWei),
    minProfitUsdWad: BigInt(config.strategy.minProfitUsdWad),
    maxNotionalUsdWad: BigInt(config.caps.maxNotionalUsdWadPerFill),
    notionalUsdWad: usdWad(amountIn, decimalsIn, priceInWad),
  };

  const result = decideFill(parsed, quote, ctx, blockNumber);
  if (result.kind === "skip") {
    deps.metrics.inc(`skip.${result.reason.replace(/\s+/g, "_")}`);
    log(`skip ${order.orderHash.slice(0, 10)}: ${result.reason}`);
    return null;
  }

  return { parsed, payloads, quote, ctx, decision: result.decision, amountIn, pythFeeWei: pythFeeFor(config, payloads) };
}
