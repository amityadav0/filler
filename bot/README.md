# Ryze UniswapX Filler — bot

Off-chain filler for UniswapX **Priority Orders on Base**, sourcing liquidity from Ryze SmartShield
pools. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the full design and milestone plan.

> **Status:** M0 scaffolding. Modules below are stubs; wiring begins at **M2** (quoter + payload-service).

## Modules (`src/`)

| Module | Milestone | Responsibility |
|---|---|---|
| `ingestor` | M2 | Poll the orders API (webhook later); filter by chain, path availability, size bands. |
| `payloads` | M2 | Hot cache of Pyth Lazer + signed CEX prices per pool asset; `getPayloads(assets)`. |
| `quoter` | M2 | Best Ryze path via `WeightedPoolQueries.querySwapExactIn` `eth_call` with `from = executor`. |
| `strategy` | M3 | Profit calc, MPS→priority-fee bid, direction shading, risk caps. |
| `submitter` | M3/M4 | Build `executor.execute` tx with `maxPriorityFeePerGas`, fresh payloads, deadline. |
| `metrics` | M3 | Counters: orders seen/quoted/bid/won/reverted, spread captured, gas burned, session state. |

## Config

`config/base.json` — addresses, pools, feed IDs, caps. Fill the `0x000…000` placeholders once Ryze is
deployed on Base (see OQ-4) and the executor is deployed (M1).

## Dev

```bash
npm install
npm run build   # tsc typecheck (M0 DoD: compiles clean in CI)
npm run lint
```
