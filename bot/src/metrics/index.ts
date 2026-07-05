// metrics (M3): counters for orders seen/quoted/bid/won/reverted, spread captured, gas burned, sessions.
export interface Metrics {
  inc(name: string, by?: number): void;
  observe(name: string, value: number): void;
}

export function createMetrics(): Metrics {
  const counters = new Map<string, number>();
  return {
    inc(name: string, by = 1): void {
      counters.set(name, (counters.get(name) ?? 0) + by);
    },
    observe(_name: string, _value: number): void {
      // wired to a Prometheus registry in M3
    },
  };
}
