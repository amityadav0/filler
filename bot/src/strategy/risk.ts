// Risk rails from ARCHITECTURE §5.2/§6 that gate an order beyond per-fill profit:
//   - per-token open-exposure cap (bound how much of one token we commit at once), and
//   - a rolling reverted-gas budget (losing priority-auction bids still cost gas — budget it as customer
//     acquisition and stop bidding once the hourly spend is exhausted).
// Both are pure/injectable-clock so they unit-test without wall-clock or network.

/** Tracks committed notional per settlement token against a per-token cap (USD WAD). */
export interface ExposureTracker {
  /** True if adding `notionalUsdWad` for `token` would stay within the cap. `0` cap disables the check. */
  canAdd(token: string, notionalUsdWad: bigint): boolean;
  /** Record committed notional for `token`. */
  add(token: string, notionalUsdWad: bigint): void;
  /** Current committed notional for `token`. */
  current(token: string): bigint;
  /** Drop committed notional for `token` (e.g. once a fill settles/closes). */
  release(token: string, notionalUsdWad: bigint): void;
}

export function createExposureTracker(maxPerTokenUsdWad: bigint): ExposureTracker {
  const byToken = new Map<string, bigint>();
  const key = (t: string) => t.toLowerCase();
  return {
    canAdd(token, notionalUsdWad) {
      if (maxPerTokenUsdWad <= 0n) return true;
      const next = (byToken.get(key(token)) ?? 0n) + notionalUsdWad;
      return next <= maxPerTokenUsdWad;
    },
    add(token, notionalUsdWad) {
      byToken.set(key(token), (byToken.get(key(token)) ?? 0n) + notionalUsdWad);
    },
    current(token) {
      return byToken.get(key(token)) ?? 0n;
    },
    release(token, notionalUsdWad) {
      const cur = byToken.get(key(token)) ?? 0n;
      const next = cur - notionalUsdWad;
      byToken.set(key(token), next > 0n ? next : 0n);
    },
  };
}

/**
 * Sliding 1-hour budget for gas burned on reverted (losing) fills. Consumed only when a fill is actually
 * broadcast and loses the auction (M4); in shadow mode nothing is sent so nothing is consumed.
 */
export interface GasBudget {
  /** Whether `gasWei` more of reverted-gas spend fits in the trailing hour. `0` budget disables the check. */
  canSpend(gasWei: bigint): boolean;
  /** Record `gasWei` of reverted-gas spend at the current time. */
  record(gasWei: bigint): void;
  /** Total reverted-gas spend in the trailing hour. */
  spentLastHour(): bigint;
}

export function createGasBudget(maxWeiPerHour: bigint, now: () => number = Date.now): GasBudget {
  const HOUR_MS = 3_600_000;
  let events: { at: number; gasWei: bigint }[] = [];
  const prune = (t: number) => {
    const cutoff = t - HOUR_MS;
    if (events.length && events[0]!.at <= cutoff) events = events.filter((e) => e.at > cutoff);
  };
  const total = () => events.reduce((s, e) => s + e.gasWei, 0n);
  return {
    canSpend(gasWei) {
      if (maxWeiPerHour <= 0n) return true;
      prune(now());
      return total() + gasWei <= maxWeiPerHour;
    },
    record(gasWei) {
      const t = now();
      prune(t);
      events.push({ at: t, gasWei });
    },
    spentLastHour() {
      prune(now());
      return total();
    },
  };
}
