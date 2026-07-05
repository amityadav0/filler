import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Address } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

export interface FillerConfig {
  chainId: number;
  chainName: string;
  ordersApi: string;
  addresses: {
    reactor: Address;
    permit2: Address;
    weth: Address;
    ryzeRouter: Address;
    ryzeQueries: Address;
    ryzeOracle: Address;
    executor: Address;
  };
  pools: PoolConfig[];
  caps: {
    maxNotionalUsdWadPerFill: string;
    maxOpenExposureUsdWadPerToken: string;
    maxRevertGasWeiPerHour: string;
    payloadMaxAgeMs: number;
  };
  strategy: {
    spreadCaptureBps: number;
    improvingDirectionShadeBps: number;
    worseningDirectionShadeBps: number;
    reQuotePriceMoveBps: number;
  };
}

export interface PoolConfig {
  pool: Address;
  tokens: Address[];
  feedIds: Record<string, string>;
  bandLimits: { maxNotionalUsdWad: string };
}

/** Load a network config file (defaults to base.json). */
export function loadConfig(network = "base"): FillerConfig {
  const path = join(here, "..", "config", `${network}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as FillerConfig;
}
