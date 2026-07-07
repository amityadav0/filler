import { test } from "node:test";
import assert from "node:assert/strict";
import { createPayloadService, isFresh, type PayloadSource } from "../src/payloads/index.js";
import type { Address, PayloadBundle } from "../src/types.js";

const A: Address = "0x1111111111111111111111111111111111111111";
const B: Address = "0x2222222222222222222222222222222222222222";

function bundle(fetchedAtMs: number): PayloadBundle {
  return {
    pythUpdateData: ["0xdead"],
    cexPriceData: [],
    prices: [
      { token: A, priceWad: 1000n },
      { token: B, priceWad: 2000n },
    ],
    pythFeedCount: 2,
    fetchedAtMs,
  };
}

test("isFresh respects maxAge", () => {
  assert.equal(isFresh(bundle(1000), 500, 1400), true);
  assert.equal(isFresh(bundle(1000), 500, 1501), false);
});

test("cache serves fresh bundles and refetches stale ones", async () => {
  let clock = 10_000;
  let fetches = 0;
  const source: PayloadSource = {
    async fetch() {
      fetches++;
      return bundle(clock);
    },
  };
  const svc = createPayloadService({ source, maxAgeMs: 1000, now: () => clock });

  await svc.getPayloads([A, B]); // miss -> fetch #1
  await svc.getPayloads([B, A]); // same set (order-independent) still fresh -> hit
  clock += 1500; // now stale
  await svc.getPayloads([A, B]); // miss -> fetch #2

  assert.equal(fetches, 2);
  const s = svc.stats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 2);
});

test("unconfigured source surfaces a clear error", async () => {
  const { createUnconfiguredSource } = await import("../src/payloads/index.js");
  const svc = createPayloadService({ source: createUnconfiguredSource(), maxAgeMs: 1000 });
  await assert.rejects(() => svc.getPayloads([A, B]), /not configured/);
});
