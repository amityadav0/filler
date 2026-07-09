// Filler entrypoint. Assembles the modules and runs either the M2 dry-run (quote only) or the M3 shadow loop
// (quote → bid → build fill tx, never sent).
import { JsonRpcProvider, type Signer, type Wallet } from "ethers";
import { loadConfig, allPoolAssets, type FillerConfig } from "./config.js";
import { createIngestor } from "./ingestor/index.js";
import { createPayloadService, createUnconfiguredSource, type PayloadSource } from "./payloads/index.js";
import {
  createRyzeSignedPriceSource,
  createCexWsClient,
  createPythLazerWsClient,
} from "./payloads/source.js";
import { hasPayloadEnv, loadPayloadEnv, loadOperatorWallet } from "./env.js";
import { createQuoter } from "./quoter/index.js";
import { createSubmitter } from "./submitter/index.js";
import { createTokenMeta } from "./chain/tokens.js";
import { createMetrics } from "./metrics/index.js";
import { createExposureTracker, createGasBudget } from "./strategy/risk.js";
import { runDryRunPass } from "./dryRun.js";
import { runShadowPass } from "./shadow.js";
import { runLivePass } from "./live.js";

export interface FillerOptions {
  network?: string;
  rpcUrl?: string;
  /** Real Pyth Lazer + signed-CEX source; defaults to env-driven wiring (or a throwing stub without env). */
  payloadSource?: PayloadSource;
  /** Operator wallet for live sends (unconnected; the filler attaches its provider). */
  wallet?: Wallet;
}

export function createFiller(opts: FillerOptions = {}) {
  const config: FillerConfig = loadConfig(opts.network ?? "base");
  const rpcUrl = opts.rpcUrl ?? process.env.RPC_URL ?? "";
  const provider = new JsonRpcProvider(rpcUrl, config.chainId);

  const ingestor = createIngestor({ ordersApi: config.ordersApi, chainId: config.chainId });
  const payloads = createPayloadService({
    source: opts.payloadSource ?? defaultPayloadSource(config),
    maxAgeMs: config.caps.payloadMaxAgeMs,
  });
  const quoter = createQuoter({
    provider,
    queriesAddress: config.addresses.ryzeQueries,
    executorAddress: config.addresses.executor,
    pools: config.pools,
  });
  const signer: Signer | undefined = opts.wallet?.connect(provider);
  const submitter = createSubmitter({
    executor: config.addresses.executor,
    chainId: config.chainId,
    ...(signer ? { signer } : {}),
  });
  const tokenMeta = createTokenMeta(provider);
  const metrics = createMetrics();

  return { config, provider, ingestor, payloads, quoter, submitter, tokenMeta, metrics, signer };
}

/** Real payload source when the pipeline env is set; otherwise the unconfigured stub (throws on use). */
function defaultPayloadSource(config: FillerConfig): PayloadSource {
  if (!hasPayloadEnv()) return createUnconfiguredSource();
  const env = loadPayloadEnv();
  const feedIdByToken: Record<string, string> = {};
  const feedIds = new Set<number>();
  for (const p of config.pools) {
    for (const [token, feedId] of Object.entries(p.feedIds)) {
      feedIdByToken[token.toLowerCase()] = feedId;
      feedIds.add(Number(feedId));
    }
  }

  const cexClient = createCexWsClient({ urls: env.ryzePricingWsUrls, symbols: config.oracle.cexAssets });
  const pythClient = createPythLazerWsClient({
    feedIds: [...feedIds],
    accessToken: env.pythAccessToken,
    ...(env.pythStreamUrls ? { endpoints: env.pythStreamUrls } : {}),
    stalenessMs: config.caps.payloadMaxAgeMs,
  });
  // Open both streams so their hot caches fill before the first quote.
  cexClient.start();
  pythClient.start();

  return createRyzeSignedPriceSource({ cexClient, pythClient, feedIdByToken });
}

/** Run the M2 dry-run loop: quote live orders and log would-be spread. Sends no transactions. */
export async function runDryRun(opts: FillerOptions = {}, intervalMs = 1000): Promise<void> {
  const f = createFiller(opts);
  console.log(`filler dry-run on ${f.config.chainName} (chainId ${f.config.chainId})`);
  for (;;) {
    try {
      await runDryRunPass({
        chainId: f.config.chainId,
        weth: f.config.addresses.weth,
        assets: allPoolAssets(f.config),
        ingestor: f.ingestor,
        payloads: f.payloads,
        quoter: f.quoter,
        metrics: f.metrics,
      });
    } catch (err) {
      console.error(`dry-run pass failed: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Run the M4 LIVE loop: quote, bid, and SEND fill transactions. Requires the operator wallet
 * (OPERATOR_KEYSTORE + OPERATOR_KEYSTORE_PASSWORD, or OPERATOR_PRIVATE_KEY) and owner sign-off (RUNBOOK §5).
 * Every send is bounded by the per-fill/min-profit strategy gates, the per-token exposure cap, and the rolling
 * reverted-gas budget.
 */
export async function runLive(opts: FillerOptions = {}, intervalMs = 1000): Promise<void> {
  const wallet = opts.wallet ?? (await loadOperatorWallet());
  if (!wallet) {
    throw new Error("live mode needs a signer: set OPERATOR_KEYSTORE + OPERATOR_KEYSTORE_PASSWORD (or OPERATOR_PRIVATE_KEY)");
  }
  const f = createFiller({ ...opts, wallet });
  console.log(
    `filler LIVE on ${f.config.chainName} (chainId ${f.config.chainId}) — SENDING FILLS as ${await f.signer!.getAddress()}`,
  );
  const exposure = createExposureTracker(BigInt(f.config.caps.maxOpenExposureUsdWadPerToken));
  const gasBudget = createGasBudget(BigInt(f.config.caps.maxRevertGasWeiPerHour));
  for (;;) {
    try {
      await runLivePass({
        config: f.config,
        provider: f.provider,
        ingestor: f.ingestor,
        payloads: f.payloads,
        quoter: f.quoter,
        submitter: f.submitter,
        tokenMeta: f.tokenMeta,
        metrics: f.metrics,
        exposure,
        gasBudget,
      });
    } catch (err) {
      console.error(`live pass failed: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Run the M3 shadow loop: quote, bid, and build fill txs (never sent). Logs would-be P&L. */
export async function runShadow(opts: FillerOptions = {}, intervalMs = 1000): Promise<void> {
  const f = createFiller(opts);
  console.log(`filler SHADOW on ${f.config.chainName} (chainId ${f.config.chainId}) — no txs will be sent`);
  // Exposure rail persists across passes so cumulative would-be commitment per token is bounded.
  const exposure = createExposureTracker(BigInt(f.config.caps.maxOpenExposureUsdWadPerToken));
  for (;;) {
    try {
      await runShadowPass({
        config: f.config,
        provider: f.provider,
        ingestor: f.ingestor,
        payloads: f.payloads,
        quoter: f.quoter,
        submitter: f.submitter,
        tokenMeta: f.tokenMeta,
        metrics: f.metrics,
        exposure,
      });
    } catch (err) {
      console.error(`shadow pass failed: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
