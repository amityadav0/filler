// Filler entrypoint (M3): wire ingestor → quoter → strategy → submitter with payloads + metrics.
import { loadConfig } from "./config.js";
import { createIngestor } from "./ingestor/index.js";
import { createPayloadService } from "./payloads/index.js";
import { createQuoter } from "./quoter/index.js";
import { createStrategy } from "./strategy/index.js";
import { createSubmitter } from "./submitter/index.js";
import { createMetrics } from "./metrics/index.js";

export function createFiller(network = "base") {
  const config = loadConfig(network);
  return {
    config,
    ingestor: createIngestor(),
    payloads: createPayloadService(),
    quoter: createQuoter(),
    strategy: createStrategy(),
    submitter: createSubmitter(),
    metrics: createMetrics(),
  };
}
