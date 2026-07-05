# Ryze UniswapX Filler — bot

Off-chain filler for UniswapX **Priority Orders on Base**, sourcing liquidity from Ryze SmartShield
pools. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the full design and milestone plan.

> **Status:** M2 — `ingestor`, `payloads`, and `quoter` implemented; a **dry-run** loop quotes orders and logs
> would-be P&L incl. sessionized fees. `strategy`/`submitter` bid + send land in M3. No transactions are sent.

## Modules (`src/`)

| Module | Milestone | State | Responsibility |
|---|---|---|---|
| `ingestor` | M2 | ✅ | Poll the orders API; parse cosigned Priority orders via `@uniswap/uniswapx-sdk`; dedupe by hash. |
| `payloads` | M2 | ✅ | Freshness-checked cache of Pyth Lazer + signed-CEX payloads; pluggable `PayloadSource` (feed client = OQ-1). |
| `quoter` | M2 | ✅ | Ryze net-out via `WeightedPoolQueries.querySwapExactIn` `staticCall` with `from = executor` (session-aware). |
| `strategy` | M2/M3 | 🟡 | `economics.ts` (MPS scaling, spread) + `evaluateFill` done; bid optimization + shading + caps = M3. |
| `submitter` | M3/M4 | ⬜ | Build `executor.execute` tx with `maxPriorityFeePerGas`, fresh payloads, deadline. |
| `metrics` | M3 | 🟡 | In-memory counters wired into the dry-run; Prometheus registry = M3. |

## Dry-run

```bash
npm install
npm run build           # tsc typecheck
npm test                # unit tests (economics, payload freshness, path finding)
RPC_URL=<base-rpc> npm run dry-run
```

The dry-run polls live Base Priority orders, quotes each through Ryze, and logs
`spread / sessionized slippage / WBF / WBR` per order plus payload cache hit-rate. Two external blockers gate a
fully-live dry-run:

- **OQ-4:** Ryze must be deployed on Base — set `ryzeQueries` / `ryzeOracle` / pool addresses in `config/base.json`.
- **OQ-1:** wire a real `PayloadSource` (Pyth Lazer + signed-CEX client) via `runDryRun({ payloadSource })`; the
  default source throws until configured.

The ingestor and parser already work against the live UniswapX orders API today.

## Config

`config/base.json` — addresses, pools, feed IDs, caps. Fill the `0x000…000` placeholders once Ryze is deployed on
Base (OQ-4) and the executor is deployed (M1/M4).
