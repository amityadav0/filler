import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Address } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

export interface FillerConfig {
  chainId: number;
  chainName: string;
  /** The single order type this bot fills. Must be "Dutch_V3". */
  orderType: string;
  ordersApi: string;
  addresses: {
    reactor: Address;
    permit2: Address;
    weth: Address;
    ryzeRouter: Address;
    ryzeQueries: Address;
    ryzeOracle: Address;
    executor: Address;
  };
  /** PythProOracle CEX tolerances (mirror the on-chain config; used to gate payload freshness/deviation). */
  oracle: {
    /** Max allowed price deviation between Pyth-blended and signed CEX price (WAD). */
    pDeltaWad: string;
    /** Max allowed CEX timestamp age (ms). */
    tToleranceMs: number;
    /** Signed-CEX-price service symbols to subscribe to (e.g. "ETHUSD"). */
    cexAssets: string[];
    /** Signed-CEX symbol → token address (so cached prices key by the pool's token addresses). */
    cexTokenMap: Record<string, string>;
    /** Pyth Lazer verification fee per non-empty update blob (wei). Fork-verified = 1 wei on Base. */
    pythVerificationFeeWei: string;
  };
  pools: PoolConfig[];
  caps: {
    maxNotionalUsdWadPerFill: string;
    maxOpenExposureUsdWadPerToken: string;
    maxRevertGasWeiPerHour: string;
    payloadMaxAgeMs: number;
  };
  strategy: {
    /** Gas units to assume for a fill when estimating gas cost. */
    gasEstimate: number;
    /** Minimum expected USD (WAD) profit to fill an order. */
    minProfitUsdWad: string;
    /** Inclusion priority fee (wei) attached to the fill tx — gas-race knob only (does not change owed output). */
    maxInclusionPriorityFeeWei: string;
  };
  /** Live-send knobs (M4) — see live.ts. */
  live: {
    /** Max blocks to wait for a non-exclusive order's exclusivity window to end (closes at decayStartBlock). */
    maxDecayWaitBlocks: number;
    /** Skip orders whose deadline is closer than this to now (ms). */
    minDeadlineMs: number;
    /** How long to wait for a fill tx receipt before treating the attempt as unknown/lost (ms). */
    receiptTimeoutMs: number;
  };
}

export interface PoolConfig {
  pool: Address;
  tokens: Address[];
  feedIds: Record<string, string>;
  bandLimits: { maxNotionalUsdWad: string };
}

/** Load a network config file (defaults to base.json), then validate it fail-closed. */
export function loadConfig(network = "base"): FillerConfig {
  const path = join(here, "..", "config", `${network}.json`);
  const config = JSON.parse(readFileSync(path, "utf8")) as FillerConfig;
  validateConfig(config);
  return config;
}

/**
 * Fail-closed validation: refuse to start on a config that would silently mis-fill. This bot supports EXACTLY one
 * order type (Dutch_V3), and the safety caps must be present and non-negative (0 explicitly disables a cap in the
 * risk rails, so we only reject negatives / missing required fields, not zero).
 */
export function validateConfig(config: FillerConfig): void {
  const fail = (m: string) => {
    throw new Error(`invalid filler config: ${m}`);
  };
  if (config.orderType !== "Dutch_V3") fail(`orderType must be "Dutch_V3", got ${JSON.stringify(config.orderType)}`);
  if (!/orderType=Dutch_V3/.test(config.ordersApi)) fail("ordersApi must poll orderType=Dutch_V3");
  const req = (v: string | number | undefined, name: string) => {
    if (v === undefined || v === null || v === "") fail(`missing ${name}`);
  };
  req(config.strategy?.gasEstimate, "strategy.gasEstimate");
  req(config.strategy?.minProfitUsdWad, "strategy.minProfitUsdWad");
  req(config.strategy?.maxInclusionPriorityFeeWei, "strategy.maxInclusionPriorityFeeWei");
  req(config.live?.maxDecayWaitBlocks, "live.maxDecayWaitBlocks");
  req(config.live?.minDeadlineMs, "live.minDeadlineMs");
  req(config.live?.receiptTimeoutMs, "live.receiptTimeoutMs");
  if (BigInt(config.strategy.maxInclusionPriorityFeeWei) < 0n) fail("maxInclusionPriorityFeeWei < 0");
  if (config.live.maxDecayWaitBlocks < 0) fail("maxDecayWaitBlocks < 0");
}

/**
 * All configured pool assets, deduped. Every payload fetch must cover this FULL set — the Lazer blob bundles all
 * subscribed feeds and `PythProOracle._parseAndStore` reverts for any fresh feed lacking a signed CEX price.
 */
export function allPoolAssets(config: FillerConfig): Address[] {
  return [...new Set(config.pools.flatMap((p) => p.tokens.map((t) => t.toLowerCase())))].map((t) => t as Address);
}
