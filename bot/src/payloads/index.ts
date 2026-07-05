// payload-service (M2): hot cache of Pyth Lazer + signed CEX prices per pool asset.
//
// The whole filler lives or dies on payload freshness: the quote is only executable while the Pyth Lazer payload
// and CEX signatures the tx carries pass `PythProOracle` verification. This service caches the latest bundle per
// asset-set and refreshes it from a pluggable `PayloadSource` when it goes stale.
import type { Address, PayloadBundle } from "../types.js";

export interface PayloadService {
  /** Fresh payloads + prices for the given assets; throws if the source can't produce a fresh bundle. */
  getPayloads(assets: Address[]): Promise<PayloadBundle>;
  /** Cache hit/miss counters for metrics. */
  stats(): PayloadStats;
}

export interface PayloadStats {
  hits: number;
  misses: number;
  lastFetchAgeMs: number | null;
}

/**
 * Source of raw payloads — the real Pyth Lazer + signed-CEX client. Pluggable so the cache/freshness logic is
 * testable in isolation and the CoW engine can reuse it. See OQ-1 (who signs `cexPriceData` in production).
 */
export interface PayloadSource {
  fetch(assets: Address[]): Promise<PayloadBundle>;
}

export interface PayloadServiceOptions {
  source: PayloadSource;
  /** Max age a cached bundle may reach before a getPayloads() forces a refetch. */
  maxAgeMs: number;
  /** Injectable clock for tests (defaults to Date.now). */
  now?: () => number;
}

/** True if `bundle` is still within `maxAgeMs` of `now`. */
export function isFresh(bundle: PayloadBundle, maxAgeMs: number, now: number): boolean {
  return now - bundle.fetchedAtMs <= maxAgeMs;
}

/** Stable cache key for a set of assets (order-independent, case-insensitive). */
function keyOf(assets: Address[]): string {
  return assets
    .map((a) => a.toLowerCase())
    .sort()
    .join(",");
}

export function createPayloadService(opts: PayloadServiceOptions): PayloadService {
  const now = opts.now ?? Date.now;
  const cache = new Map<string, PayloadBundle>();
  let hits = 0;
  let misses = 0;
  let lastFetchAt: number | null = null;

  return {
    async getPayloads(assets: Address[]): Promise<PayloadBundle> {
      const key = keyOf(assets);
      const cached = cache.get(key);
      if (cached && isFresh(cached, opts.maxAgeMs, now())) {
        hits++;
        return cached;
      }
      misses++;
      const bundle = await opts.source.fetch(assets);
      cache.set(key, bundle);
      lastFetchAt = bundle.fetchedAtMs;
      return bundle;
    },
    stats(): PayloadStats {
      return { hits, misses, lastFetchAgeMs: lastFetchAt === null ? null : now() - lastFetchAt };
    },
  };
}

/**
 * Placeholder source until the production feed pipeline is wired (OQ-1). Real implementation: subscribe to Pyth
 * Lazer, hold the latest signed-CEX prices, and assemble `{pythUpdateData, cexPriceData, prices}` per asset.
 */
export function createUnconfiguredSource(): PayloadSource {
  return {
    async fetch(): Promise<PayloadBundle> {
      throw new Error("payload source not configured — wire the Pyth Lazer + signed-CEX client (OQ-1)");
    },
  };
}
