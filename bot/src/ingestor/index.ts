// order-ingestor (M2): poll orders API (webhook later); parse Priority orders via the UniswapX SDK.
// The SDK is CommonJS; Node's ESM interop only exposes its classes via the default import, not named exports.
import sdk from "@uniswap/uniswapx-sdk";
import type { Address, ParsedOrder, ParsedOutput } from "../types.js";

const { CosignedPriorityOrder } = sdk;

/** UniswapX native-ETH output sentinel. */
const NATIVE = "0x0000000000000000000000000000000000000000";

export interface OpenOrder {
  orderHash: string;
  encodedOrder: `0x${string}`;
  signature: `0x${string}`;
  auctionTargetBlock?: number;
}

/** Shape of a row in the UniswapX orders API `orders` array (fields we consume). */
interface OrdersApiRow {
  orderHash: string;
  encodedOrder: `0x${string}`;
  signature: `0x${string}`;
  type?: string;
  chainId?: number;
}

export interface Ingestor {
  /** Fetch newly-seen open Priority orders (dedupes by orderHash across calls). */
  poll(): Promise<OpenOrder[]>;
}

export interface IngestorOptions {
  ordersApi: string;
  chainId: number;
  /** Injectable fetch for tests (defaults to global fetch). */
  fetchFn?: typeof fetch;
  /** Max order hashes to remember for dedup before evicting the oldest (bounds memory on long runs). */
  seenLimit?: number;
}

export function createIngestor(opts: IngestorOptions): Ingestor {
  const fetchFn = opts.fetchFn ?? fetch;
  const seenLimit = opts.seenLimit ?? 50_000;
  // Insertion-ordered; oldest entries evicted first once the cap is reached (open orders are short-lived, so an
  // evicted-then-reappearing hash is a rare, harmless re-emit).
  const seen = new Map<string, true>();

  return {
    async poll(): Promise<OpenOrder[]> {
      const resp = await fetchFn(opts.ordersApi);
      if (!resp.ok) throw new Error(`orders API ${resp.status}`);
      const body = (await resp.json()) as { orders?: OrdersApiRow[] };
      const rows = body.orders ?? [];
      const fresh: OpenOrder[] = [];
      for (const row of rows) {
        if (seen.has(row.orderHash)) continue;
        seen.set(row.orderHash, true);
        if (seen.size > seenLimit) {
          const oldest = seen.keys().next().value;
          if (oldest !== undefined) seen.delete(oldest);
        }
        fresh.push({ orderHash: row.orderHash, encodedOrder: row.encodedOrder, signature: row.signature });
      }
      return fresh;
    },
  };
}

/**
 * Decode an open Priority order (cosigned) into the fields the quoter + strategy need.
 *
 * Covers ALL output legs (main output + any protocol/interface fee output), not just the first: the executor
 * must settle every leg, so the economics must account for every leg. Native-ETH outputs (`address(0)`) are
 * normalized to `wethAddress` as the settlement token (the executor unwraps WETH → ETH for the reactor).
 * `multiToken` is set when the legs span more than one settlement token — such orders can't be sourced by a
 * single Ryze swap and are skipped downstream.
 */
export function parsePriorityOrder(order: OpenOrder, chainId: number, wethAddress: Address): ParsedOrder {
  const parsed = CosignedPriorityOrder.parse(order.encodedOrder, chainId);
  const info = parsed.info;
  if (!info.outputs.length) throw new Error(`order ${order.orderHash} has no outputs`);
  const toBig = (n: { toString(): string }) => BigInt(n.toString());
  const weth = wethAddress.toLowerCase();

  const outputs: ParsedOutput[] = info.outputs.map((o) => {
    const token = o.token as Address;
    const isNative = token.toLowerCase() === NATIVE;
    return {
      token,
      settlementToken: (isNative ? wethAddress : token) as Address,
      amount: toBig(o.amount),
      mpsPerWei: toBig(o.mpsPerPriorityFeeWei),
      recipient: o.recipient as Address,
    };
  });

  const settlementTokens = new Set(outputs.map((o) => o.settlementToken.toLowerCase()));
  const hasNativeOutput = outputs.some((o) => o.token.toLowerCase() === NATIVE);
  const multiToken = settlementTokens.size > 1;
  // Quote/source against the (single) settlement token; if multiToken, this is just the first — the order is
  // skipped by the strategy before the value is used.
  const tokenOut = (outputs.find((o) => o.settlementToken.toLowerCase() === weth)?.settlementToken ??
    outputs[0]!.settlementToken) as Address;

  return {
    orderHash: order.orderHash,
    encodedOrder: order.encodedOrder,
    signature: order.signature,
    swapper: info.swapper as Address,
    tokenIn: info.input.token as Address,
    amountIn: toBig(info.input.amount),
    inputMpsPerWei: toBig(info.input.mpsPerPriorityFeeWei),
    outputs,
    tokenOut,
    hasNativeOutput,
    multiToken,
    baselinePriorityFeeWei: toBig(info.baselinePriorityFeeWei),
    auctionTargetBlock: info.cosignerData.auctionTargetBlock.toNumber(),
    deadline: info.deadline,
  };
}
