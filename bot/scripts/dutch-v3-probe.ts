// Phase 0 probe #2: characterize the addressable Dutch_V3 subset — decay depth, curve span, RFQ-filler
// concentration — to size the decay-wait window and confirm the exclusivity finding. Throwaway.
import sdk from "@uniswap/uniswapx-sdk";
const { CosignedV3DutchOrder } = sdk;

const CHAIN_ID = 8453;
const API = "https://api.uniswap.org/v2/orders";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const NATIVE = "0x0000000000000000000000000000000000000000";
const ADDR = new Set([WETH, USDC, CBBTC]);
const settle = (a: string) => (a.toLowerCase() === NATIVE ? WETH : a.toLowerCase());

async function pull(maxPages: number) {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let p = 0; p < maxPages; p++) {
    const url = `${API}?orderType=Dutch_V3&orderStatus=filled&chainId=${CHAIN_ID}&limit=100&sortKey=createdAt&desc=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    const b = (await r.json()) as any;
    out.push(...(b.orders ?? []));
    if (!b.cursor || !(b.orders ?? []).length) break;
    cursor = b.cursor;
  }
  return out;
}

const rows = await pull(6);
const depths: number[] = [];
const spans: number[] = [];
const points: number[] = [];
const fillers = new Map<string, number>();
let addr = 0;
for (const row of rows) {
  let o: any;
  try {
    o = CosignedV3DutchOrder.parse(row.encodedOrder, CHAIN_ID);
  } catch {
    continue;
  }
  const info = o.info;
  const inTok = settle(info.input.token);
  const main = info.outputs.reduce((a: any, b: any) => (b.startAmount.gt(a.startAmount) ? b : a));
  const outTok = settle(main.token);
  if (!(ADDR.has(inTok) && ADDR.has(outTok))) continue;
  addr++;
  const start = BigInt(main.startAmount.toString());
  const rel = main.curve.relativeAmounts;
  const relBlocks = main.curve.relativeBlocks;
  if (rel.length && start > 0n) {
    const end = start - BigInt(rel[rel.length - 1].toString());
    depths.push(Number(((start - end) * 10000n) / start)); // bps output decays over the curve
    spans.push(relBlocks[relBlocks.length - 1]);
    points.push(rel.length);
  }
  const f = (info.cosignerData.exclusiveFiller || NATIVE).toLowerCase();
  fillers.set(f, (fillers.get(f) ?? 0) + 1);
}
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const max = (a: number[]) => (a.length ? Math.max(...a) : 0);
console.log(`addressable orders sampled: ${addr}`);
console.log(`output decay depth (start→end), bps: median ${med(depths)}, max ${max(depths)}`);
console.log(`curve block span (relativeBlocks last): median ${med(spans)}, max ${max(spans)}`);
console.log(`curve points: median ${med(points)}, max ${max(points)}`);
console.log(`distinct exclusiveFillers over addressable subset: ${fillers.size}`);
console.log(
  "top exclusiveFillers:",
  [...fillers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([f, c]) => `${f.slice(0, 8)}…=${c}`).join("  "),
);
