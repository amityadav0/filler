// Phase 0 (throwaway audit): quantify Base UniswapX Priority vs Dutch_V3 flow and the Ryze-addressable subset,
// plus the exclusivity reality check that decides whether fills are winnable by polling vs require RFQ.
//
// Run:  node --import tsx scripts/dutch-v3-audit.ts
// No auth needed — public orders API. Writes findings to stdout; hand-transcribe into DUTCH-V3-AUDIT.md.
//
// SDK: @uniswap/uniswapx-sdk 3.0.10 — CommonJS, classes only via default import (see ingestor).
import sdk from "@uniswap/uniswapx-sdk";

const { CosignedV3DutchOrder } = sdk;

const CHAIN_ID = 8453;
const API = "https://api.uniswap.org/v2/orders";

// Ryze-addressable tokens on Base (from bot/config/base.json). Native-ETH sentinel address(0) → WETH.
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const NATIVE = "0x0000000000000000000000000000000000000000";
const ADDRESSABLE = new Set([WETH, USDC, CBBTC]);
// Pairs sourceable by a *single* live Ryze pool (WETH-USDC, cbBTC-USDC).
const LIVE_POOL_PAIRS = new Set([pairKey(WETH, USDC), pairKey(CBBTC, USDC)]);

const SYMBOLS: Record<string, string> = {
  [WETH]: "WETH",
  [USDC]: "USDC",
  [CBBTC]: "cbBTC",
  [NATIVE]: "ETH",
};

function norm(a: string): string {
  return a.toLowerCase();
}
function settle(a: string): string {
  // Native-ETH is settled as WETH by the executor.
  return norm(a) === NATIVE ? WETH : norm(a);
}
function sym(a: string): string {
  return SYMBOLS[norm(a)] ?? `${a.slice(0, 6)}…${a.slice(-4)}`;
}
function pairKey(a: string, b: string): string {
  return [settle(a), settle(b)].sort().join("/");
}

interface ApiRow {
  orderHash: string;
  encodedOrder: `0x${string}`;
  signature: `0x${string}`;
  type?: string;
  createdAt?: number;
}

async function fetchOrders(orderType: string, maxPages: number): Promise<ApiRow[]> {
  const out: ApiRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const url =
      `${API}?orderType=${orderType}&orderStatus=filled&chainId=${CHAIN_ID}` +
      `&limit=100&sortKey=createdAt&desc=true` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const resp = await fetch(url, { headers: { accept: "application/json" } });
    if (!resp.ok) throw new Error(`${orderType} orders API ${resp.status}`);
    const body = (await resp.json()) as { orders?: ApiRow[]; cursor?: string };
    const rows = body.orders ?? [];
    out.push(...rows);
    if (!body.cursor || rows.length === 0) break;
    cursor = body.cursor;
  }
  return out;
}

function fillsPerDay(rows: ApiRow[]): { perDay: number; spanHours: number; n: number } {
  const ts = rows.map((r) => r.createdAt).filter((t): t is number => typeof t === "number");
  if (ts.length < 2) return { perDay: ts.length, spanHours: 0, n: ts.length };
  const spanSec = Math.max(...ts) - Math.min(...ts);
  const spanHours = spanSec / 3600;
  const perDay = spanSec > 0 ? (rows.length / spanSec) * 86400 : rows.length;
  return { perDay, spanHours, n: rows.length };
}

async function main() {
  console.log(`# Dutch_V3 audit — Base (chainId ${CHAIN_ID}), ${new Date().toISOString()}\n`);

  // --- 1. Fills/day: Priority (dead?) vs Dutch_V3 (live flow) ---
  const priority = await fetchOrders("Priority", 2);
  const dutch = await fetchOrders("Dutch_V3", 6);
  const pStat = fillsPerDay(priority);
  const dStat = fillsPerDay(dutch);
  console.log("## 1. Fills/day (filled history; API retains only a short window)");
  console.log(
    `Priority : ${pStat.n} fills over ${pStat.spanHours.toFixed(1)}h → ~${pStat.perDay.toFixed(1)}/day`,
  );
  console.log(
    `Dutch_V3 : ${dStat.n} fills over ${dStat.spanHours.toFixed(1)}h → ~${dStat.perDay.toFixed(1)}/day\n`,
  );

  // --- 2 & 3. Decode Dutch_V3: bucket by pair, addressable share, exclusivity ---
  const pairCount = new Map<string, number>();
  let parsed = 0;
  let parseFail = 0;
  let bothAddressable = 0; // both legs in {USDC,WETH,cbBTC}
  let livePoolDirect = 0; // pair is exactly a live Ryze pool
  let multiOutputToken = 0;
  let exclusive = 0; // exclusiveFiller != address(0)
  const overrideBpsHist = new Map<number, number>();

  for (const row of dutch) {
    let order: InstanceType<typeof CosignedV3DutchOrder>;
    try {
      order = CosignedV3DutchOrder.parse(row.encodedOrder, CHAIN_ID);
    } catch {
      parseFail++;
      continue;
    }
    parsed++;
    const info = order.info;
    const inTok = settle(info.input.token);
    // Main output = largest startAmount leg (fee legs are smaller / same token).
    const outSettles = new Set(info.outputs.map((o) => settle(o.token)));
    if (outSettles.size > 1) multiOutputToken++;
    const mainOut = info.outputs.reduce((a, b) => (b.startAmount.gt(a.startAmount) ? b : a));
    const outTok = settle(mainOut.token);

    const key = `${sym(inTok)} → ${sym(outTok)}`;
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1);

    const both = ADDRESSABLE.has(inTok) && ADDRESSABLE.has(outTok) && outSettles.size === 1;
    if (both) {
      bothAddressable++;
      if (LIVE_POOL_PAIRS.has(pairKey(inTok, outTok))) livePoolDirect++;
    }

    // Exclusivity reality check.
    const cd = info.cosignerData;
    if (cd.exclusiveFiller && norm(cd.exclusiveFiller) !== NATIVE) exclusive++;
    const bps = cd.exclusivityOverrideBps ? cd.exclusivityOverrideBps.toNumber() : 0;
    overrideBpsHist.set(bps, (overrideBpsHist.get(bps) ?? 0) + 1);
  }

  console.log("## 2. Dutch_V3 pair mix (input → main output), top 20 by count");
  console.log(`parsed=${parsed} parseFail=${parseFail}`);
  const sorted = [...pairCount.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, c] of sorted.slice(0, 20)) {
    console.log(`  ${String(c).padStart(4)}  ${k}`);
  }
  const pct = (n: number) => (parsed ? ((n / parsed) * 100).toFixed(1) : "0.0");
  console.log(`\n## 3. Addressability (of ${parsed} decoded Dutch_V3 orders)`);
  console.log(`  both legs in {USDC,WETH,cbBTC}, single settlement token : ${bothAddressable} (${pct(bothAddressable)}%)`);
  console.log(`    of which a direct live Ryze pool pair (1 swap)         : ${livePoolDirect} (${pct(livePoolDirect)}%)`);
  console.log(`    (the rest of 'both legs' need a WETH↔cbBTC multi-hop through USDC)`);
  console.log(`  multi-output-token orders (can't single-swap)           : ${multiOutputToken}`);

  console.log(`\n## 4. Exclusivity reality check (of ${parsed} decoded)`);
  console.log(`  orders with exclusiveFiller set (!= 0x0)                 : ${exclusive} (${pct(exclusive)}%)`);
  console.log(`  exclusivityOverrideBps histogram:`);
  for (const [bps, c] of [...overrideBpsHist.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`    ${String(bps).padStart(6)} bps : ${c}`);
  }

  // Estimate addressable fills/day = Dutch_V3 fills/day × addressable share.
  const addrPerDay = dStat.perDay * (parsed ? bothAddressable / parsed : 0);
  const liveDirectPerDay = dStat.perDay * (parsed ? livePoolDirect / parsed : 0);
  console.log(`\n## 5. GO/NO-GO inputs`);
  console.log(`  addressable Dutch_V3 fills/day (both legs)   ~ ${addrPerDay.toFixed(1)}/day`);
  console.log(`  addressable via existing live pools (1 swap) ~ ${liveDirectPerDay.toFixed(1)}/day`);
  console.log(`  exclusive share                              ~ ${pct(exclusive)}%`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
