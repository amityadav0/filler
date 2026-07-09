// metrics (M3): counters for orders seen/quoted/bid/won/reverted, spread captured, gas burned, sessions.
export interface Metrics {
  inc(name: string, by?: number): void;
  observe(name: string, value: number): void;
  /** Cumulative counter values (sorted by name) — used by the loop heartbeat; Prometheus registry is M5. */
  snapshot(): Record<string, number>;
}

export function createMetrics(): Metrics {
  const counters = new Map<string, number>();
  return {
    inc(name: string, by = 1): void {
      counters.set(name, (counters.get(name) ?? 0) + by);
    },
    observe(_name: string, _value: number): void {
      // wired to a Prometheus registry in M5
    },
    snapshot(): Record<string, number> {
      return Object.fromEntries([...counters.entries()].sort(([a], [b]) => a.localeCompare(b)));
    },
  };
}
