// Runnable entrypoint. MODE=shadow (default) builds fill txs without sending; MODE=dryrun quotes only.
// Requires RPC_URL and configured addresses (OQ-1/OQ-4).
import { runDryRun, runShadow } from "./index.js";

const mode = process.env.MODE ?? "shadow";
const run = mode === "dryrun" ? runDryRun : runShadow;

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
