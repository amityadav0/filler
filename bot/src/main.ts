// Runnable entrypoint. MODE=shadow (default) builds fill txs without sending; MODE=dryrun quotes only;
// MODE=live SENDS fills (M4 — requires the operator signer env and owner sign-off, see RUNBOOK §5).
// Requires RPC_URL plus the payload env (PYTH_PRO_ACCESS_TOKEN, RYZE_PRICING_URL) for real prices.
import { runDryRun, runShadow, runLive } from "./index.js";

const mode = process.env.MODE ?? "shadow";
const run = mode === "dryrun" ? runDryRun : mode === "live" ? runLive : runShadow;

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
