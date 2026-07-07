import { test } from "node:test";
import assert from "node:assert/strict";
import { createIngestor } from "../src/ingestor/index.js";

function jsonResponse(orders: { orderHash: string; encodedOrder: string; signature: string }[]): Response {
  return { ok: true, status: 200, async json() { return { orders }; } } as unknown as Response;
}

test("poll dedupes already-seen order hashes across calls", async () => {
  let batch = [
    { orderHash: "0x1", encodedOrder: "0xa", signature: "0xs" },
    { orderHash: "0x2", encodedOrder: "0xb", signature: "0xs" },
  ];
  const ing = createIngestor({ ordersApi: "http://x", chainId: 8453, fetchFn: async () => jsonResponse(batch) });

  assert.equal((await ing.poll()).length, 2); // both fresh
  assert.equal((await ing.poll()).length, 0); // same batch, all seen
  batch = [...batch, { orderHash: "0x3", encodedOrder: "0xc", signature: "0xs" }];
  const fresh = await ing.poll();
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]!.orderHash, "0x3");
});

test("poll bounds the seen set and re-emits an evicted hash", async () => {
  // seenLimit 2: after seeing 0x1,0x2 then 0x3, 0x1 is evicted and re-emits if it reappears.
  let batch = [{ orderHash: "0x1", encodedOrder: "0xa", signature: "0xs" }];
  const ing = createIngestor({
    ordersApi: "http://x",
    chainId: 8453,
    seenLimit: 2,
    fetchFn: async () => jsonResponse(batch),
  });

  await ing.poll(); // seen: {0x1}
  batch = [{ orderHash: "0x2", encodedOrder: "0xb", signature: "0xs" }];
  await ing.poll(); // seen: {0x1,0x2}
  batch = [{ orderHash: "0x3", encodedOrder: "0xc", signature: "0xs" }];
  await ing.poll(); // adds 0x3 -> evicts oldest 0x1; seen: {0x2,0x3}
  batch = [{ orderHash: "0x1", encodedOrder: "0xa", signature: "0xs" }];
  const fresh = await ing.poll(); // 0x1 was evicted -> re-emitted
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]!.orderHash, "0x1");
});

test("poll throws on a non-ok response", async () => {
  const ing = createIngestor({
    ordersApi: "http://x",
    chainId: 8453,
    fetchFn: async () => ({ ok: false, status: 503 }) as unknown as Response,
  });
  await assert.rejects(() => ing.poll(), /orders API 503/);
});
