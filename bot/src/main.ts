// Runnable dry-run entrypoint: `npm run dry-run` (RPC_URL env + configured addresses required).
import { runDryRun } from "./index.js";

runDryRun().catch((err) => {
  console.error(err);
  process.exit(1);
});
