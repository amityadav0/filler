// Runnable entrypoint. MODE=shadow (default) builds fill txs without sending; MODE=dryrun quotes only.
// Requires RPC_URL plus the payload env (PYTH_PRO_ACCESS_TOKEN, RYZE_PRICING_URL) for real prices.
import { runDryRun, runShadow } from "./index.js";

const mode = process.env.MODE ?? "shadow";
const run = mode === "dryrun" ? runDryRun : runShadow;

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
