import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Address } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

export interface FillerConfig {
  chainId: number;
  chainName: string;
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
    spreadCaptureBps: number;
    improvingDirectionShadeBps: number;
    worseningDirectionShadeBps: number;
    reQuotePriceMoveBps: number;
    /** Gas units to assume for a fill when estimating gas cost in shadow mode. */
    gasEstimate: number;
    /** Minimum expected USD (WAD) profit to bid on an order. */
    minProfitUsdWad: string;
    /** Hard ceiling on the priority-fee bid (wei). */
    maxBidPriorityFeeWei: string;
  };
  /** Live-send knobs (M4) — see live.ts. */
  live: {
    /** Skip orders whose auctionTargetBlock is more than this many blocks ahead of now. */
    maxTargetBlockLeadBlocks: number;
    /** Send when within this many blocks of the target (Base ≈ 2s blocks; sequencer is FCFS). */
    sendLeadBlocks: number;
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

/** Load a network config file (defaults to base.json). */
export function loadConfig(network = "base"): FillerConfig {
  const path = join(here, "..", "config", `${network}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as FillerConfig;
}

/**
 * All configured pool assets, deduped. Every payload fetch must cover this FULL set — the Lazer blob bundles all
 * subscribed feeds and `PythProOracle._parseAndStore` reverts for any fresh feed lacking a signed CEX price.
 */
export function allPoolAssets(config: FillerConfig): Address[] {
  return [...new Set(config.pools.flatMap((p) => p.tokens.map((t) => t.toLowerCase())))].map((t) => t as Address);
}
