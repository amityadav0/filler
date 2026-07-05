// order-ingestor (M2): poll orders API (webhook later); parse Priority orders via the UniswapX SDK.
import { CosignedPriorityOrder } from "@uniswap/uniswapx-sdk";
import type { Address, ParsedOrder } from "../types.js";

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
}

export function createIngestor(opts: IngestorOptions): Ingestor {
  const fetchFn = opts.fetchFn ?? fetch;
  const seen = new Set<string>();

  return {
    async poll(): Promise<OpenOrder[]> {
      const resp = await fetchFn(opts.ordersApi);
      if (!resp.ok) throw new Error(`orders API ${resp.status}`);
      const body = (await resp.json()) as { orders?: OrdersApiRow[] };
      const rows = body.orders ?? [];
      const fresh: OpenOrder[] = [];
      for (const row of rows) {
        if (seen.has(row.orderHash)) continue;
        seen.add(row.orderHash);
        fresh.push({ orderHash: row.orderHash, encodedOrder: row.encodedOrder, signature: row.signature });
      }
      return fresh;
    },
  };
}

/** Decode an open Priority order (cosigned) into the fields the quoter + strategy need. */
export function parsePriorityOrder(order: OpenOrder, chainId: number): ParsedOrder {
  const parsed = CosignedPriorityOrder.parse(order.encodedOrder, chainId);
  const info = parsed.info;
  const output = info.outputs[0];
  if (!output) throw new Error(`order ${order.orderHash} has no outputs`);
  const toBig = (n: { toString(): string }) => BigInt(n.toString());

  return {
    orderHash: order.orderHash,
    encodedOrder: order.encodedOrder,
    signature: order.signature,
    swapper: info.swapper as Address,
    tokenIn: info.input.token as Address,
    amountIn: toBig(info.input.amount),
    inputMpsPerWei: toBig(info.input.mpsPerPriorityFeeWei),
    tokenOut: output.token as Address,
    baselineAmountOut: toBig(output.amount),
    outputMpsPerWei: toBig(output.mpsPerPriorityFeeWei),
    outputRecipient: output.recipient as Address,
    baselinePriorityFeeWei: toBig(info.baselinePriorityFeeWei),
    auctionTargetBlock: info.cosignerData.auctionTargetBlock.toNumber(),
    deadline: info.deadline,
  };
}
