// order-ingestor: poll the UniswapX orders API for open **Dutch_V3** orders on Base and decode them via the SDK.
// The SDK is CommonJS; Node's ESM interop only exposes its classes via the default import, not named exports.
import sdk from "@uniswap/uniswapx-sdk";
import type { Address, DecayCurve, ParsedOrder, ParsedOutput } from "../types.js";

// VERIFIED against the installed @uniswap/uniswapx-sdk@3.0.10: the cosigned Dutch_V3 order class is
// `CosignedV3DutchOrder` (default export), with `.parse(encoded, chainId)` and `.info` carrying
// `input: V3DutchInput`, `outputs: V3DutchOutput[]`, and `cosignerData: { decayStartBlock, exclusiveFiller,
// exclusivityOverrideBps, inputOverride, outputOverrides }`. Each leg's decay is a `{ relativeBlocks: number[],
// relativeAmounts: bigint[] }` curve. (There is no more `CosignedPriorityOrder` path in this bot.)
const { CosignedV3DutchOrder } = sdk;

/** UniswapX native-ETH output sentinel. */
const NATIVE = "0x0000000000000000000000000000000000000000";

export interface OpenOrder {
  orderHash: string;
  encodedOrder: `0x${string}`;
  signature: `0x${string}`;
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
  /** Fetch newly-seen open Dutch_V3 orders (dedupes by orderHash across calls). */
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

const toBig = (n: { toString(): string }) => BigInt(n.toString());

/** A cosigner override of 0 means "no override" — keep the original amount (mirrors SDK `originalIfZero`). */
function originalIfZero(override: { isZero(): boolean; toString(): string }, original: bigint): bigint {
  return override.isZero() ? original : toBig(override);
}

/** Extract a leg's decay curve from the SDK's `{ relativeBlocks, relativeAmounts }` (relativeAmounts already bigint). */
function toCurve(curve: { relativeBlocks: number[]; relativeAmounts: bigint[] }): DecayCurve {
  return {
    relativeBlocks: [...curve.relativeBlocks],
    relativeAmounts: curve.relativeAmounts.map((a) => BigInt(a.toString())),
  };
}

/**
 * Decode an open cosigned Dutch_V3 order into the fields the quoter + strategy need.
 *
 * Covers ALL output legs (main output + any protocol/interface fee output), not just the first: the executor must
 * settle every leg, so the economics must account for every leg. Native-ETH outputs (`address(0)`) are normalized
 * to `wethAddress` as the settlement token (the executor unwraps WETH → ETH for the reactor). `multiToken` is set
 * when the legs span more than one settlement token — such orders can't be sourced by a single Ryze swap and are
 * skipped downstream. Cosigner input/output overrides are folded into the leg start amounts here (exactly as the
 * on-chain reactor resolves them), so `startAmount` is the effective decay anchor.
 */
export function parseDutchV3Order(order: OpenOrder, chainId: number, wethAddress: Address): ParsedOrder {
  const parsed = CosignedV3DutchOrder.parse(order.encodedOrder, chainId);
  const info = parsed.info;
  if (!info.outputs.length) throw new Error(`order ${order.orderHash} has no outputs`);
  const weth = wethAddress.toLowerCase();
  const cd = info.cosignerData;

  const outputs: ParsedOutput[] = info.outputs.map((o, idx) => {
    const token = o.token as Address;
    const isNative = token.toLowerCase() === NATIVE;
    return {
      token,
      settlementToken: (isNative ? wethAddress : token) as Address,
      startAmount: originalIfZero(cd.outputOverrides[idx] ?? o.startAmount, toBig(o.startAmount)),
      curve: toCurve(o.curve),
      recipient: o.recipient as Address,
    };
  });

  const settlementTokens = new Set(outputs.map((o) => o.settlementToken.toLowerCase()));
  const hasNativeOutput = outputs.some((o) => o.token.toLowerCase() === NATIVE);
  const multiToken = settlementTokens.size > 1;
  // Quote/source against the (single) settlement token; if multiToken, this is just the WETH leg (or the first) —
  // the order is skipped by the strategy before the value is used.
  const tokenOut = (outputs.find((o) => o.settlementToken.toLowerCase() === weth)?.settlementToken ??
    outputs[0]!.settlementToken) as Address;

  // decayEndBlock = decayStartBlock + the furthest relative block across every leg (owed is flat past it).
  const maxRel = Math.max(
    0,
    ...info.input.curve.relativeBlocks,
    ...info.outputs.flatMap((o) => o.curve.relativeBlocks),
  );

  return {
    orderHash: order.orderHash,
    encodedOrder: order.encodedOrder,
    signature: order.signature,
    swapper: info.swapper as Address,
    tokenIn: info.input.token as Address,
    inputStartAmount: originalIfZero(cd.inputOverride, toBig(info.input.startAmount)),
    inputCurve: toCurve(info.input.curve),
    outputs,
    tokenOut,
    hasNativeOutput,
    multiToken,
    decayStartBlock: cd.decayStartBlock,
    decayEndBlock: cd.decayStartBlock + maxRel,
    exclusiveFiller: cd.exclusiveFiller as Address,
    exclusivityOverrideBps: toBigNum(cd.exclusivityOverrideBps),
    deadline: info.deadline,
  };
}

/** exclusivityOverrideBps arrives as an ethers BigNumber; it is a small integer. */
function toBigNum(n: { toNumber(): number }): number {
  return n.toNumber();
}
