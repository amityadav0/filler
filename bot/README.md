# Ryze UniswapX Filler — bot

Off-chain filler for UniswapX **Priority Orders on Base**, sourcing liquidity from Ryze SmartShield
pools. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the full design and milestone plan.

> **Status:** M3 — full loop runs in **shadow mode**: poll → quote → choose a priority-fee bid → BUILD the fill
> tx (never sent) → log would-be P&L. Live sending (M4) is gated behind `send: true` + a signer and owner sign-off.

## Modules (`src/`)

| Module | Milestone | State | Responsibility |
|---|---|---|---|
| `ingestor` | M2 | ✅ | Poll the orders API; parse cosigned Priority orders (ALL output legs, native→WETH) via `@uniswap/uniswapx-sdk`; bounded dedupe by hash. |
| `payloads` | M2 | ✅ | Freshness-checked cache; real `PayloadSource` in `payloads/source.ts` composes Pyth Lazer + signed-CEX (wire-format reconcile = OQ-1). |
| `quoter` | M2 | ✅ | Ryze net-out via `WeightedPoolQueries.querySwapExactIn` `staticCall` with `from = executor` (session-aware). |
| `strategy` | M3 | ✅ | `economics.ts` (multi-leg MPS scaling) + `decideBid` (capture-target bid, shading, USD profit incl. gas, caps) + `risk.ts` (exposure + reverted-gas budget). |
| `submitter` | M3 | ✅ | Encode FillData + build EIP-1559 `executor.execute` tx; shadow builds only, live send gated (M4). |
| `metrics` | M3 | 🟡 | In-memory counters wired into the loop; Prometheus registry = M5. |

## Run

```bash
npm install
npm run build              # tsc typecheck
npm test                   # 38 unit tests (economics, risk, payloads, ingestor, quoter, strategy, submitter, shadow loop)
RPC_URL=<base-rpc> npm run shadow    # M3: bid + build fill txs (never sent)
RPC_URL=<base-rpc> npm run dry-run   # M2: quote only
```

The loop polls live Base Priority orders, quotes each through Ryze, chooses a bid, and logs
`bid / effFee / owed / kept spread / profit(USD) / gas(USD) / direction` per order plus payload cache hit-rate.
**No transactions are sent** in shadow mode.

### Payload-pipeline env (real prices)

When these are set, `createFiller` uses the real `PayloadSource`; otherwise it falls back to a stub that throws
on use. See [`../RUNBOOK.md`](../RUNBOOK.md).

```bash
export PYTH_PRO_ACCESS_TOKEN=<token>                        # Pyth Lazer Bearer token
# signed-CEX WS (subscribe by symbol). Feed is SPLIT across hosts — list BOTH, comma-separated:
export RYZE_PRICING_URL=wss://us1.mainnet.pricing.ryze.pro/ws,wss://us-signed-price-4tyzr.ondigitalocean.app/ws
# export PYTH_PRO_STREAM_URLS=wss://...   # optional; defaults to the 3 dourolabs endpoints
```

`payloads/source.ts` is a standalone, clean-room TS implementation (no coupling to the Go bots): a signed-CEX WS
client (subscribe-by-symbol) + a Pyth Lazer WS client (subscribe-by-feed-id, Bearer auth, `evm.data` →
`pythUpdateData`), composed into a `PayloadSource`. Wire formats are unit-tested; validate live prices against a
known feed before enabling M4 sends.

## Config

`config/base.json` — Ryze addresses (router/queries/oracle), pools (WETH-USDC, WBTC-USDC), Pyth feed IDs, oracle
tolerances, and caps are all filled for Base. The only remaining placeholder is `addresses.executor` — set it
after deploying `RyzeUniswapXExecutor` (see `../RUNBOOK.md` §2).
