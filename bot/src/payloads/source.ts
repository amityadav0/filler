// Real PayloadSource: assembles the per-asset {pythUpdateData, cexPriceData, prices} bundle the fill tx carries.
//
// Standalone, clean-room TypeScript — no dependency on the Go limit-order-bot; only its confirmed wire formats
// are reproduced here. Two independent websocket feeds are composed:
//   1. Ryze signed-CEX-price service — a WS you subscribe to BY SYMBOL; each update carries a signed price
//      (`price_in_wad`, `timestamp`, `v/r/s`) → the on-chain `CexPriceData` the PythProOracle verifies.
//   2. Pyth Lazer (Pro) — a WS you subscribe to BY numeric feed id (Bearer-auth); each update carries a single
//      `evm.data` blob (all subscribed feeds) → the `pythUpdateData` the oracle consumes.
//
// The wire-facing parsing is isolated in pure, unit-tested helpers; the WS clients wrap them with
// connect/subscribe/reconnect. Economics prices come from the signed-CEX feed (authoritative WAD values checked
// on-chain); Pyth contributes the update blob.
import WebSocket from "ws";
import type { Address, CexPriceData, PayloadBundle, TokenPrice } from "../types.js";
import type { PayloadSource } from "./index.js";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; no sockets)
// ---------------------------------------------------------------------------

/** Pyth Lazer (Pro) websocket endpoints. */
export const LAZER_ENDPOINTS = [
  "wss://pyth-lazer-0.dourolabs.app/v1/stream",
  "wss://pyth-lazer-1.dourolabs.app/v1/stream",
  "wss://pyth-lazer-2.dourolabs.app/v1/stream",
];

/** Lazer subscription channel. Verified live: feeds 631/397 reject `fixed_rate@50ms`; `@200ms` is accepted. */
export const LAZER_CHANNEL_MAINNET = "fixed_rate@200ms";
const LAZER_SUBSCRIPTION_ID = 1;

/** Raw signed-CEX websocket message (snake_case as sent by the pricing service). */
interface CexWsMessage {
  token: string;
  symbol: string;
  price_in_wad: string;
  timestamp: number;
  v: number;
  r: string;
  s: string;
}

/** Subscription frame for the signed-CEX feed (subscribe by symbol). */
export function buildCexSubscribe(symbols: string[]): string {
  return JSON.stringify({ action: "subscribe", symbols });
}

/**
 * True for the service's non-price control frames (e.g. the on-connect welcome `{type, client_id, message,
 * timestamp}`), which carry no `token`/`price_in_wad` and must be ignored rather than parsed. Verified live
 * against both signed-price hosts.
 */
export function isCexControlFrame(raw: unknown): boolean {
  const m = raw as { token?: unknown; price_in_wad?: unknown };
  return typeof m?.token !== "string" || m?.price_in_wad === undefined;
}

/** Parse one signed-CEX message into the on-chain `CexPriceData` (throws on a malformed message). */
export function parseCexMessage(raw: unknown): CexPriceData & { symbol: string } {
  const m = raw as Partial<CexWsMessage>;
  if (!m || typeof m.token !== "string" || m.price_in_wad === undefined) {
    throw new Error("cex ws: malformed message");
  }
  const r = m.r?.startsWith("0x") ? m.r : `0x${m.r}`;
  const s = m.s?.startsWith("0x") ? m.s : `0x${m.s}`;
  return {
    token: m.token as Address,
    symbol: String(m.symbol ?? ""),
    priceInWad: BigInt(m.price_in_wad),
    timestamp: BigInt(m.timestamp ?? 0),
    v: Number(m.v),
    r: r as `0x${string}`,
    s: s as `0x${string}`,
  };
}

/** Subscription frame for Pyth Lazer (subscribe by numeric feed id, EVM format). */
export function buildLazerSubscribe(feedIds: number[], channel = LAZER_CHANNEL_MAINNET): string {
  return JSON.stringify({
    type: "subscribe",
    subscriptionId: LAZER_SUBSCRIPTION_ID,
    priceFeedIds: feedIds,
    properties: ["price", "exponent", "confidence", "feedUpdateTimestamp"],
    formats: ["evm"],
    channel,
    parsed: true,
    jsonBinaryEncoding: "hex",
  });
}

/** Decode a Lazer `evm.data` blob (hex or base64) to a `0x`-prefixed hex string. */
export function decodeEvmData(encoding: string, data: string): `0x${string}` {
  if (encoding === "hex") {
    const h = data.startsWith("0x") ? data.slice(2) : data;
    return `0x${h}`;
  }
  if (encoding === "base64") {
    return `0x${Buffer.from(data, "base64").toString("hex")}`;
  }
  throw new Error(`lazer: unknown evm encoding ${encoding}`);
}

/**
 * Extract the shared EVM update blob from a Lazer stream message. Returns null for non-update / no-evm messages.
 * The single blob contains every subscribed feed, so it is the whole `pythUpdateData` for a fill.
 */
export function parseLazerUpdate(raw: unknown): `0x${string}` | null {
  const m = raw as { type?: string; evm?: { encoding?: string; data?: string }; error?: string };
  if (m?.error) throw new Error(`lazer stream error: ${m.error}`);
  if (m?.type !== "streamUpdated" || !m.evm?.data) return null;
  return decodeEvmData(m.evm.encoding ?? "hex", m.evm.data);
}

// ---------------------------------------------------------------------------
// Feed clients (injectable interfaces so the composition is testable)
// ---------------------------------------------------------------------------

export interface CexPriceClient {
  fetchSigned(assets: Address[]): Promise<{ cex: CexPriceData[]; prices: TokenPrice[] }>;
}

export interface PythLazerClient {
  /**
   * Latest shared update blob plus `feedCount` = number of feeds the blob carries (all subscribed feeds; Lazer
   * bundles them into one blob). The oracle bills the Pyth verification fee per feed, so this drives the fill fee.
   */
  latest(feedIds: string[]): Promise<{ pythUpdateData: `0x${string}`[]; prices: TokenPrice[]; feedCount: number }>;
  close(): void;
}

/** A hot-cache websocket client with connect/subscribe/reconnect. `start()` connects; reads populate a cache. */
export interface StreamingClient {
  start(): void;
  close(): void;
}

interface WsClientOptions {
  url: string;
  /** Subscription frame sent on every (re)connect. */
  subscribeFrame: string;
  /** Handle one parsed JSON message. */
  onMessage: (msg: unknown) => void;
  authToken?: string;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Minimal reconnecting websocket loop shared by both feeds. */
function connectLoop(opts: WsClientOptions): StreamingClient {
  const log = opts.log ?? (() => {});
  let ws: WebSocket | null = null;
  let closed = false;
  let backoffMs = 1000;

  const open = () => {
    if (closed) return;
    const headers = opts.authToken ? { Authorization: `Bearer ${opts.authToken}` } : undefined;
    const sock = new WebSocket(opts.url, { headers });
    ws = sock;
    sock.on("open", () => {
      backoffMs = 1000;
      sock.send(opts.subscribeFrame);
    });
    sock.on("message", (data: WebSocket.RawData) => {
      try {
        opts.onMessage(JSON.parse(data.toString()));
      } catch (err) {
        log(`ws parse error: ${(err as Error).message}`);
      }
    });
    const reconnect = () => {
      if (closed) return;
      const delay = backoffMs;
      backoffMs = Math.min(backoffMs * 2, 10_000);
      setTimeout(open, delay);
    };
    sock.on("close", reconnect);
    sock.on("error", (err) => {
      log(`ws error: ${(err as Error).message}`);
      try {
        sock.close();
      } catch {
        /* already closing */
      }
    });
  };

  return {
    start: open,
    close() {
      closed = true;
      ws?.close();
    },
  };
}

/**
 * Signed-CEX websocket client: subscribe by symbol, cache the latest signed price per token address.
 * Accepts MULTIPLE endpoint URLs and merges them into one cache — the mainnet signed-price service is split
 * across hosts (one streams USDC, another streams ETH/BTC), so full token coverage needs all of them.
 */
export function createCexWsClient(opts: {
  urls: string[];
  symbols: string[];
  stalenessMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}): CexPriceClient & StreamingClient {
  const now = opts.now ?? Date.now;
  const staleness = opts.stalenessMs ?? 60_000;
  const cache = new Map<string, { price: CexPriceData & { symbol: string }; at: number }>();

  const streams = opts.urls.map((url) =>
    connectLoop({
      url,
      subscribeFrame: buildCexSubscribe(opts.symbols),
      log: opts.log,
      onMessage: (msg) => {
        if (isCexControlFrame(msg)) return; // welcome/control frame — no price to cache
        const p = parseCexMessage(msg);
        cache.set(p.token.toLowerCase(), { price: p, at: now() });
      },
    }),
  );

  return {
    start() {
      for (const s of streams) s.start();
    },
    close() {
      for (const s of streams) s.close();
    },
    async fetchSigned(assets: Address[]) {
      const cex: CexPriceData[] = [];
      const prices: TokenPrice[] = [];
      for (const a of assets) {
        const hit = cache.get(a.toLowerCase());
        if (!hit) throw new Error(`cex: no signed price for ${a}`);
        if (now() - hit.at > staleness) throw new Error(`cex: stale signed price for ${a}`);
        const { symbol: _symbol, ...cexData } = hit.price;
        cex.push(cexData);
        prices.push({ token: hit.price.token, priceWad: hit.price.priceInWad });
      }
      return { cex, prices };
    },
  };
}

/** Pyth Lazer websocket client: subscribe by feed id, cache the latest shared EVM update blob. */
export function createPythLazerWsClient(opts: {
  feedIds: number[];
  accessToken: string;
  endpoints?: string[];
  channel?: string;
  stalenessMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}): PythLazerClient & StreamingClient {
  const now = opts.now ?? Date.now;
  const staleness = opts.stalenessMs ?? 5_000;
  const endpoints = opts.endpoints ?? LAZER_ENDPOINTS;
  let latestBlob: { blob: `0x${string}`; at: number } | null = null;

  // Connect to all endpoints; whichever delivers freshest wins (Lazer sends the same feeds on each).
  const streams = endpoints.map((url) =>
    connectLoop({
      url,
      authToken: opts.accessToken,
      subscribeFrame: buildLazerSubscribe(opts.feedIds, opts.channel),
      log: opts.log,
      onMessage: (msg) => {
        const blob = parseLazerUpdate(msg);
        if (blob) latestBlob = { blob, at: now() };
      },
    }),
  );

  return {
    start() {
      for (const s of streams) s.start();
    },
    close() {
      for (const s of streams) s.close();
    },
    async latest() {
      if (!latestBlob) throw new Error("pyth lazer: no update received yet");
      if (now() - latestBlob.at > staleness) throw new Error("pyth lazer: update stale");
      // The one blob carries every subscribed feed; the oracle bills the verification fee per feed.
      return { pythUpdateData: [latestBlob.blob], prices: [], feedCount: opts.feedIds.length };
    },
  };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface RyzeSignedPriceSourceOptions {
  cexClient: CexPriceClient;
  pythClient: PythLazerClient;
  /** Pyth Lazer feed id per token address (from pool config `feedIds`). */
  feedIdByToken: Record<string, string>;
  /** Injectable clock (defaults to Date.now). */
  now?: () => number;
}

/**
 * Compose the two feeds into a PayloadSource. Prices come from the signed-CEX feed (authoritative WAD values the
 * on-chain oracle verifies); the Pyth Lazer blob rides along as `pythUpdateData`. Throws if any requested asset
 * lacks a configured feed id or a returned price.
 */
export function createRyzeSignedPriceSource(opts: RyzeSignedPriceSourceOptions): PayloadSource {
  const now = opts.now ?? Date.now;
  const feedOf = (t: Address) => opts.feedIdByToken[t.toLowerCase()];
  return {
    async fetch(assets: Address[]): Promise<PayloadBundle> {
      const feedIds: string[] = [];
      for (const a of assets) {
        const f = feedOf(a);
        if (!f) throw new Error(`no Pyth Lazer feed id configured for ${a}`);
        feedIds.push(f);
      }

      const [pyth, cex] = await Promise.all([
        opts.pythClient.latest(feedIds),
        opts.cexClient.fetchSigned(assets),
      ]);

      const priceByToken = new Map<string, TokenPrice>();
      for (const p of cex.prices) priceByToken.set(p.token.toLowerCase(), p);
      for (const p of pyth.prices) priceByToken.set(p.token.toLowerCase(), p); // pyth overrides if provided
      const prices: TokenPrice[] = [];
      for (const a of assets) {
        const p = priceByToken.get(a.toLowerCase());
        if (!p) throw new Error(`no price returned for ${a}`);
        prices.push(p);
      }

      return {
        pythUpdateData: pyth.pythUpdateData,
        cexPriceData: cex.cex,
        prices,
        pythFeedCount: pyth.feedCount,
        fetchedAtMs: now(),
      };
    },
  };
}
