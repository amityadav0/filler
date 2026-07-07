# Follow-up Steps

Prioritized plan from fork-verification (2026-07-07) to live fills and beyond. Companion to
[RUNBOOK.md](./RUNBOOK.md) (how to run each step) and [ARCHITECTURE.md](./ARCHITECTURE.md) (design).
State as of writing: **M0–M3 done, mainnet-fork fill gate PASSED, all open questions resolved or non-blocking.**

## Phase 1 — Go live, capped (owner ops + one code task)

| # | Step | Who | Notes |
|---|---|---|---|
| 1 | Deploy `RyzeUniswapXExecutor` to Base | owner key | RUNBOOK §2. `APPROVE_USDC/WETH/WBTC=true`. One-time, ~$0.01 gas. |
| 2 | Whitelist executor on the router | Ryze pool owner (`0x0A2C…`) | `setWhitelistedIntentSwapper(executor, true)`. **Hard blocker** — `pauseDirectSwap` is ON (fork-verified). |
| 3 | Set `addresses.executor` in `bot/config/base.json` | anyone | Quoter sessionization + submitter target. |
| 4 | **Code: wire the live send path** | bot | The only remaining code gap for M4 (see backlog L1): auctionTargetBlock gating, gas-budget consumption on losses, exposure release on settlement, `minProfitUsdWad > 0`. |
| 5 | Shadow-run ~1 week with real feeds | ops | ~10 addressable orders/day expected. Review spread histogram + `skip.*` reasons; tune `spreadCaptureBps`. |
| 6 | Fund operator (~0.05 ETH), flip `send: true`, verify ONE fill end-to-end | owner sign-off | Then scale caps gradually. No other capital needed — fills are atomic. |

## Phase 2 — Hardening (M5)

- **Webhook order feed** (register with Uniswap Labs) — polling adds up to ~1s latency; priority auctions are
  won at the target block, so latency = missed auctions.
- **Prometheus metrics + alerting** — `metrics/` counters exist; wire a registry + revert-loss and payload-staleness alerts.
- **Per-pool fill serialization** — avoid session drift when two of our fills race into one pool (ARCHITECTURE §6).
- **Win/loss bid tuning** — feed submitter outcomes back into `spreadCaptureBps` (start 60%, tune per pair).
- **Publish the third-party "route through Ryze" integration doc** — extract from executor + quoter (secondary
  goal in ARCHITECTURE §1; unlocks other solvers sending Ryze volume).

## Phase 3 — Growth

- **More pools/pairs**: 2/3 of Base priority flow is in pairs we can't touch yet (long-tail vs USDC/WETH).
  Each new Ryze pool directly expands addressable flow — share the pair/volume data with the Ryze team.
- **Multi-hop quoting** (`findSingleHop` → path search) — enables e.g. cbBTC→WETH via USDC once flow justifies it.
- **CoW solver engine** — reuses this repo's quoter + payload layers per the original plan.

---

## Code-review backlog (2026-07-07 full review)

Fixed in the same change as this doc:

- ✅ **Shadow exposure leak** — `exposure.add()` was never released; a week-long shadow run would ratchet to the
  cap and skip everything (`exposure_over_cap`), silently garbaging the data. Now released for unsent fills.
- ✅ **Submitter `maxFeePerGas` headroom** — was exactly `baseFee + bid`; any next-block baseFee uptick silently
  missed the auction. Now `2×baseFee + bid` (EIP-1559 refunds the unused part; effective tip is still ≤ bid).
- ✅ **Executor batch guard** — `reactorCallback` sources output for `orders[0]` only but settled all orders; a
  future batch entrypoint would have under-sourced. Now reverts `SingleOrderOnly` (baked in pre-deploy).
- ✅ **dryRun payload coverage** — now fetches all pool assets (`allPoolAssets`), same as shadow.

### L1 — live send path (Phase 1 step 4, must precede `send: true`)

The shadow loop builds txs but the live path needs order-lifecycle awareness the shadow never exercises:

1. **`auctionTargetBlock` gating**: a fill submitted before the target block reverts `OrderNotFillable`.
   Submit targeting that block (or schedule); skip orders whose `deadline` is near.
2. **Gas-budget consumption**: `createGasBudget` exists (`strategy/risk.ts`) but is not consulted/recorded by
   any send path. Wire: check `canSpend` before send; `record()` when a sent fill reverts (lost auction).
3. **Exposure lifecycle**: on `sent: true`, hold exposure until the fill settles/reverts, then `release`.
4. **Config**: set `minProfitUsdWad` > 0 (currently `"0"` — would bid on break-even fills).
5. **Re-quote-at-send**: payloads are fetched at quote time; re-fetch immediately before send and re-check the
   spread if price moved > `reQuotePriceMoveBps` (config knob exists, unused).

### L2 — robustness improvements (before or during early live)

- **Ingestor re-emit**: dedupe by hash means ONE bid attempt per order ever; if payloads were stale at that
  moment the order is lost. Track open-order lifecycle and re-emit while still open and unexpired.
- **`isImproving` heuristic is weak** (`strategy/index.ts`): `sessionizedWbf === 0` classifies nearly all small
  fills as improving (live quotes show wbf=0 below a size threshold both directions) → capture always shaded
  down 5%. Use the pool's weight-vs-target direction from the quote instead, or drop shading until measured.
- **Quoter error taxonomy**: `querySwapExactIn` reverts (band exceeded, paused) surface as generic
  `orders.error`; decode common custom errors into distinct `skip.*` metrics so shadow data explains itself.
- **`metrics.observe()` is a no-op** — fine until Prometheus (M5), but don't rely on it before then.

### L3 — nice-to-have

- Executor: `sweep`/`sweepNative` batching (multicall) for spread collection; not urgent at current volume.
- `payloadService` cache: single-flight de-dupe if two passes fetch concurrently (currently only same-tick reuse).
- Fork-fill harness: add a native-ETH-output order variant (executor unwrap path is unit-tested but not
  fork-tested); add a deliberately-underpriced pyth fee case asserting the exact oracle revert.
- CI: run `npm run build && npm test` for the bot on PRs touching `bot/` only (currently always runs — fine, just slow).
