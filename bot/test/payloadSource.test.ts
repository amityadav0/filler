import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRyzeSignedPriceSource,
  parseCexMessage,
  buildCexSubscribe,
  buildLazerSubscribe,
  isCexControlFrame,
  decodeEvmData,
  parseLazerUpdate,
} from "../src/payloads/source.js";
import type { Address } from "../src/types.js";

const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH: Address = "0x4200000000000000000000000000000000000006";

test("composes pyth + cex feeds into a bundle (cex prices authoritative)", async () => {
  const src = createRyzeSignedPriceSource({
    feedIdByToken: { [USDC.toLowerCase()]: "7", [WETH.toLowerCase()]: "631" },
    now: () => 12345,
    pythClient: {
      async latest(feedIds) {
        assert.deepEqual(feedIds, ["7", "631"]);
        return { pythUpdateData: ["0xdeadbeef"], prices: [] };
      },
      close() {},
    },
    cexClient: {
      async fetchSigned(assets) {
        assert.deepEqual(assets, [USDC, WETH]);
        return {
          cex: [
            { token: USDC, priceInWad: 1_000_000_000_000_000_000n, timestamp: 111n, v: 27, r: "0xaa", s: "0xbb" },
            { token: WETH, priceInWad: 3_000_000_000_000_000_000_000n, timestamp: 111n, v: 28, r: "0xcc", s: "0xdd" },
          ],
          prices: [
            { token: USDC, priceWad: 1_000_000_000_000_000_000n },
            { token: WETH, priceWad: 3_000_000_000_000_000_000_000n },
          ],
        };
      },
    },
  });

  const bundle = await src.fetch([USDC, WETH]);
  assert.equal(bundle.fetchedAtMs, 12345);
  assert.deepEqual(bundle.pythUpdateData, ["0xdeadbeef"]);
  assert.equal(bundle.cexPriceData.length, 2);
  assert.equal(bundle.prices.find((p) => p.token === WETH)?.priceWad, 3_000_000_000_000_000_000_000n);
});

test("fetch throws when an asset has no configured feed id", async () => {
  const src = createRyzeSignedPriceSource({
    feedIdByToken: {},
    pythClient: { async latest() { return { pythUpdateData: [], prices: [] }; }, close() {} },
    cexClient: { async fetchSigned() { return { cex: [], prices: [] }; } },
  });
  await assert.rejects(() => src.fetch([USDC]), /no Pyth Lazer feed id/);
});

test("parseCexMessage maps the signed-CEX wire shape and 0x-pads r/s", () => {
  const p = parseCexMessage({
    token: WETH,
    symbol: "ETHUSD",
    price_in_wad: "3000000000000000000000",
    timestamp: 1720000000000,
    v: 27,
    r: "aa",
    s: "0xbb",
  });
  assert.equal(p.token, WETH);
  assert.equal(p.priceInWad, 3_000_000_000_000_000_000_000n);
  assert.equal(p.timestamp, 1_720_000_000_000n);
  assert.equal(p.r, "0xaa");
  assert.equal(p.s, "0xbb");
  assert.throws(() => parseCexMessage({ symbol: "X" }), /malformed/);
});

test("isCexControlFrame skips the on-connect welcome frame but not price frames", () => {
  // Exact shape both signed-price hosts send on connect (verified live).
  assert.equal(isCexControlFrame({ client_id: "abc", message: "connected", timestamp: 1, type: "welcome" }), true);
  assert.equal(
    isCexControlFrame({ token: WETH, symbol: "ETHUSD", price_in_wad: "1", timestamp: 1, v: 27, r: "0x", s: "0x" }),
    false,
  );
});

test("buildCexSubscribe / buildLazerSubscribe produce the expected frames", () => {
  assert.deepEqual(JSON.parse(buildCexSubscribe(["ETHUSD", "USDCUSD"])), {
    action: "subscribe",
    symbols: ["ETHUSD", "USDCUSD"],
  });
  const sub = JSON.parse(buildLazerSubscribe([631, 7]));
  assert.equal(sub.type, "subscribe");
  assert.deepEqual(sub.priceFeedIds, [631, 7]);
  assert.deepEqual(sub.formats, ["evm"]);
  assert.equal(sub.parsed, true);
  assert.equal(sub.channel, "fixed_rate@200ms");
});

test("decodeEvmData handles hex and base64; rejects unknown", () => {
  assert.equal(decodeEvmData("hex", "0xdeadbeef"), "0xdeadbeef");
  assert.equal(decodeEvmData("hex", "deadbeef"), "0xdeadbeef");
  assert.equal(decodeEvmData("base64", Buffer.from("deadbeef", "hex").toString("base64")), "0xdeadbeef");
  assert.throws(() => decodeEvmData("cbor", "x"), /unknown evm encoding/);
});

test("parseLazerUpdate returns the evm blob for stream updates, null otherwise, throws on error", () => {
  assert.equal(
    parseLazerUpdate({ type: "streamUpdated", evm: { encoding: "hex", data: "0xabcd" } }),
    "0xabcd",
  );
  assert.equal(parseLazerUpdate({ type: "subscribed" }), null);
  assert.equal(parseLazerUpdate({ type: "streamUpdated" }), null); // no evm
  assert.throws(() => parseLazerUpdate({ error: "bad feed" }), /lazer stream error/);
});
