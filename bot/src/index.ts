// Filler entrypoint. Assembles the modules and runs either the M2 dry-run (quote only) or the M3 shadow loop
// (quote → bid → build fill tx, never sent).
import { JsonRpcProvider } from "ethers";
import { loadConfig, type FillerConfig } from "./config.js";
import { createIngestor } from "./ingestor/index.js";
import { createPayloadService, createUnconfiguredSource, type PayloadSource } from "./payloads/index.js";
import { createQuoter } from "./quoter/index.js";
import { createSubmitter } from "./submitter/index.js";
import { createTokenMeta } from "./chain/tokens.js";
import { createMetrics } from "./metrics/index.js";
import { runDryRunPass } from "./dryRun.js";
import { runShadowPass } from "./shadow.js";

export interface FillerOptions {
  network?: string;
  rpcUrl?: string;
  /** Real Pyth Lazer + signed-CEX source; defaults to the unconfigured stub (OQ-1). */
  payloadSource?: PayloadSource;
}

export function createFiller(opts: FillerOptions = {}) {
  const config: FillerConfig = loadConfig(opts.network ?? "base");
  const rpcUrl = opts.rpcUrl ?? process.env.RPC_URL ?? "";
  const provider = new JsonRpcProvider(rpcUrl, config.chainId);

  const ingestor = createIngestor({ ordersApi: config.ordersApi, chainId: config.chainId });
  const payloads = createPayloadService({
    source: opts.payloadSource ?? createUnconfiguredSource(),
    maxAgeMs: config.caps.payloadMaxAgeMs,
  });
  const quoter = createQuoter({
    provider,
    queriesAddress: config.addresses.ryzeQueries,
    executorAddress: config.addresses.executor,
    pools: config.pools,
  });
  const submitter = createSubmitter({ executor: config.addresses.executor, chainId: config.chainId });
  const tokenMeta = createTokenMeta(provider);
  const metrics = createMetrics();

  return { config, provider, ingestor, payloads, quoter, submitter, tokenMeta, metrics };
}

/** Run the M2 dry-run loop: quote live orders and log would-be spread. Sends no transactions. */
export async function runDryRun(opts: FillerOptions = {}, intervalMs = 1000): Promise<void> {
  const f = createFiller(opts);
  console.log(`filler dry-run on ${f.config.chainName} (chainId ${f.config.chainId})`);
  for (;;) {
    try {
      await runDryRunPass({
        chainId: f.config.chainId,
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

/** Run the M3 shadow loop: quote, bid, and build fill txs (never sent). Logs would-be P&L. */
export async function runShadow(opts: FillerOptions = {}, intervalMs = 1000): Promise<void> {
  const f = createFiller(opts);
  console.log(`filler SHADOW on ${f.config.chainName} (chainId ${f.config.chainId}) — no txs will be sent`);
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
      });
    } catch (err) {
      console.error(`shadow pass failed: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
