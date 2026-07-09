# Follow-up Steps

Prioritized plan to live fills and beyond. Companion to [RUNBOOK.md](./RUNBOOK.md) (how to run each step) and
[ARCHITECTURE.md](./ARCHITECTURE.md) (design).
State as of writing: **migrated Priority → Dutch_V3 (2026-07-10); order model, economics, strategy, live-loop,
config, tests, and fork harness rebuilt (tsc + `npm test` + `forge test` green). Remaining: redeploy the executor,
shadow-run, and — the real go-live gate — RFQ registration.** See [DUTCH-V3-AUDIT.md](./DUTCH-V3-AUDIT.md).

## Phase 1 — Go live, capped (owner ops)

| # | Step | Who | Notes |
|---|---|---|---|
| 1 | **Redeploy `RyzeUniswapXExecutor` bound to the V3DutchOrderReactor** | owner key | RUNBOOK §2 (`REACTOR` now defaults to `0x0000…7ba0`). The old executor is Priority-bound and CANNOT fill Dutch_V3. `APPROVE_USDC/WETH/CBBTC=true`. One-time, ~$0.01 gas. |
| 2 | Whitelist the new executor on the router | Ryze pool owner (`0x0A2C…`) | `setWhitelistedIntentSwapper(executor, true)`. **Hard blocker** — `pauseDirectSwap` is ON (fork-verified). |
| 3 | Set `addresses.executor` in `bot/config/base.json` | anyone | Quoter sessionization + submitter target (currently `0x0` placeholder). |
| 4 | Shadow-run ~1 week with real feeds | ops | Confirms the bot now **sees Dutch_V3 orders** (the original 0-orders symptom was the dead Priority poll). Expect most addressable orders to log as lost to exclusivity — that is the RFQ finding, not a bug. Review spread histogram + `skip.*`. |
| 5 | **RFQ registration (real go-live gate — see Phase RFQ)** | owner + Uniswap Labs | Without becoming the `exclusiveFiller`, polling wins ~nothing (92% of flow is exclusivity-locked). Do this before expecting live P&L. |
| 6 | Fund operator (~0.05 ETH), flip `MODE=live`, verify ONE fill end-to-end | owner sign-off | Then scale caps gradually. No other capital needed — fills are atomic. |

## Phase RFQ — the real path to winning fills (do before scaling)

The audit ([DUTCH-V3-AUDIT.md](./DUTCH-V3-AUDIT.md)) shows ~92% of addressable Base Dutch_V3 flow carries an
`exclusiveFiller` with a 25 bps override, and one incumbent wins ~75% of it. As an unregistered poller we must
beat the curve by ≥25 bps during the exclusivity window (or wait past `decayStartBlock` and race the incumbent on
the leftover decayed value) — we lose structurally, not on latency. **Polling wins ~nothing.**

Design note (scope, not yet built):

- **Register as a UniswapX RFQ quoter** with Uniswap Labs so Ryze-priceable quote requests route to us and, when
  we win, WE become the `exclusiveFiller` (no handicap, first crack during the window).
- **Answer the quote webhook** with a Ryze-backed price: reuse the existing `quoter` (session-aware
  `querySwapExactIn`, `from = executor`) + `payload-service` — the same net-out math already used for polling,
  minus the on-chain decay (we quote a price; Uniswap builds the decay curve around it).
- **Latency budget:** RFQ responses are time-boxed (~hundreds of ms). Keep a hot quote/payload cache; pre-warm
  per-pool sessions. The payload pipeline already maintains hot caches.
- **Then the existing fill path takes over:** once we hold exclusivity, `live.ts` fills at/after `decayStartBlock`
  with the same executor/submitter — no on-chain change.
- Do NOT block the Phase 1 shadow bring-up on this, but it IS the live-P&L gate — do not raise caps expecting
  polling to win.

## Phase 2 — Hardening (M5)

- **RFQ webhook feed** (Phase RFQ) — the primary latency/exclusivity fix; polling `orderStatus=open` is a fallback.
- **Prometheus metrics + alerting** — `metrics/` counters exist; wire a registry + revert-loss and payload-staleness alerts.
- **Per-pool fill serialization** — avoid session drift when two of our fills race into one pool (ARCHITECTURE §6).
- **Decay-wait tuning** — from shadow/live data, tune `maxDecayWaitBlocks` and whether to ever wait for extra
  decay past `decayStartBlock` (vs fill-immediately-when-profitable to beat competitors).
- **Publish the third-party "route through Ryze" integration doc** — extract from executor + quoter (secondary
  goal in ARCHITECTURE §1; unlocks other solvers sending Ryze volume).

## Phase 3 — Growth

- **More pools/pairs**: the bulk of Base Dutch_V3 flow is long-tail-token ↔ WETH/USDC — pairs we can't touch yet.
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

### L1 — live send path ✅ DONE (2026-07-09; reworked for Dutch_V3 timing 2026-07-10, `bot/src/live.ts`)

All items implemented and unit-tested (`bot/test/live.test.ts`); shared per-order evaluation extracted to
`prepare.ts` (used by both shadow and live):

1. ✅ **Dutch decay/exclusivity timing** (replaced `auctionTargetBlock` gating): for a polled (non-exclusive)
   order, wait until just past `decayStartBlock` so the exclusivity handicap drops and decay has begun; skip if
   that is > `maxDecayWaitBlocks` ahead or the deadline is closer than `minDeadlineMs`.
2. ✅ Gas budget — `canSpend(worst-case)` before send; `record(actual)` on revert/timeout; blocks further sends
   once `maxRevertGasWeiPerHour` is consumed.
3. ✅ Exposure lifecycle — held from send until the receipt lands (win, revert, or timeout), then released.
4. ✅ `minProfitUsdWad` = $0.10 in config.
5. ✅ Re-quote at send — fresh payloads fetched immediately before send; aborts if the fresh quote no longer
   clears the resolved owed. The inclusion priority fee is a gas-race knob only (does not change owed).

Run: `OPERATOR_KEYSTORE=~/.foundry/keystores/operator OPERATOR_KEYSTORE_PASSWORD=… MODE=live npm run live`
(RUNBOOK §5). Signer loads from the encrypted foundry keystore — no raw key in env.

### L2 — robustness improvements (before or during early live)

- **Ingestor re-emit**: dedupe by hash means ONE bid attempt per order ever; if payloads were stale at that
  moment the order is lost. Track open-order lifecycle and re-emit while still open and unexpired.
- **`isImproving` heuristic is weak** (`strategy/index.ts`): `sessionizedWbf === 0` classifies nearly all small
  fills as improving. It is now only an observability/pair-skip signal (no MPS shading remains), so the impact is
  cosmetic — but if it later drives a wait-threshold nudge, base it on the pool's weight-vs-target direction.
- **Quoter error taxonomy**: `querySwapExactIn` reverts (band exceeded, paused) surface as generic
  `orders.error`; decode common custom errors into distinct `skip.*` metrics so shadow data explains itself.
- **`metrics.observe()` is a no-op** — fine until Prometheus (M5), but don't rely on it before then.

### L3 — nice-to-have

- Executor: `sweep`/`sweepNative` batching (multicall) for spread collection; not urgent at current volume.
- `payloadService` cache: single-flight de-dupe if two passes fetch concurrently (currently only same-tick reuse).
- Fork-fill harness: add a native-ETH-output order variant (executor unwrap path is unit-tested but not
  fork-tested); add a deliberately-underpriced pyth fee case asserting the exact oracle revert.
- CI: run `npm run build && npm test` for the bot on PRs touching `bot/` only (currently always runs — fine, just slow).
