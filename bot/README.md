# Ryze UniswapX Filler — bot

Off-chain filler for UniswapX **Priority Orders on Base**, sourcing liquidity from Ryze SmartShield
pools. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the full design and milestone plan.

> **Status:** M3 — full loop runs in **shadow mode**: poll → quote → choose a priority-fee bid → BUILD the fill
> tx (never sent) → log would-be P&L. Live sending (M4) is gated behind `send: true` + a signer and owner sign-off.

## Modules (`src/`)

| Module | Milestone | State | Responsibility |
|---|---|---|---|
| `ingestor` | M2 | ✅ | Poll the orders API; parse cosigned Priority orders via `@uniswap/uniswapx-sdk`; dedupe by hash. |
| `payloads` | M2 | ✅ | Freshness-checked cache of Pyth Lazer + signed-CEX payloads; pluggable `PayloadSource` (feed client = OQ-1). |
| `quoter` | M2 | ✅ | Ryze net-out via `WeightedPoolQueries.querySwapExactIn` `staticCall` with `from = executor` (session-aware). |
| `strategy` | M3 | ✅ | `economics.ts` (MPS scaling) + `decideBid`: capture-target bid, direction shading, USD profit incl. gas, caps. |
| `submitter` | M3 | ✅ | Encode FillData + build EIP-1559 `executor.execute` tx; shadow builds only, live send gated (M4). |
| `metrics` | M3 | 🟡 | In-memory counters wired into the loop; Prometheus registry = M3/M5. |

## Run

```bash
npm install
npm run build              # tsc typecheck
npm test                   # 20 unit tests (economics, payloads, quoter, strategy, submitter, shadow loop)
RPC_URL=<base-rpc> npm run shadow    # M3: bid + build fill txs (never sent)
RPC_URL=<base-rpc> npm run dry-run   # M2: quote only
```

The loop polls live Base Priority orders, quotes each through Ryze, chooses a bid, and logs
`bid / effFee / owed / kept spread / profit(USD) / gas(USD) / direction` per order plus payload cache hit-rate.
**No transactions are sent** in shadow mode. Two external blockers gate a fully-live run:

- **OQ-4:** Ryze must be deployed on Base — set `ryzeQueries` / `ryzeOracle` / pool addresses in `config/base.json`.
- **OQ-1:** wire a real `PayloadSource` (Pyth Lazer + signed-CEX client) via `runDryRun({ payloadSource })`; the
  default source throws until configured.

The ingestor and parser already work against the live UniswapX orders API today.

## Config

`config/base.json` — addresses, pools, feed IDs, caps. Fill the `0x000…000` placeholders once Ryze is deployed on
Base (OQ-4) and the executor is deployed (M1/M4).
