# Dutch_V3 Audit — Base UniswapX flow (Phase 0)

> Generated 2026-07-09 from the public orders API (no auth) via `bot/scripts/dutch-v3-audit.ts` +
> `bot/scripts/dutch-v3-probe.ts`. SDK `@uniswap/uniswapx-sdk@3.0.10` (`CosignedV3DutchOrder`).
> The API retains only a short trailing window of `filled` history — figures are rates over that window,
> not lifetime totals.

## GO / NO-GO (one line)

**GO to build the migration plumbing (Phases 1–5) — the order flow is unambiguously in Dutch_V3, not Priority —
but live fills are NOT winnable by open-order polling. 92% of flow is RFQ-exclusive to incumbents; shipping real
wins requires registering as an RFQ quoter (Phase 6). Treat Phase 6, not Phase 5, as the live-go gate.**

## 1. Priority is dead; Dutch_V3 is the flow

| Order type | Fills in window | Window | Rate |
|---|---|---|---|
| Priority | 66 | 464.9 h (~19 d) | **~3.4 / day** |
| Dutch_V3 | 696 | 195.9 h (~8 d) | **~85 / day** |

Priority averages one fill every ~7 h and is effectively abandoned on Base. Dutch_V3 carries ~25× the flow.
The bot's original "sees 0 orders" symptom is explained: it was polling the dead Priority lane.

## 2. Addressable subset (the number that decides worth-shipping)

Of 696 decoded Dutch_V3 orders (0 parse failures):

- **Both legs in {USDC, WETH, cbBTC}, single settlement token: 80 (11.5%) → ~9.8 fills/day.**
- Of those, a **direct live Ryze pool pair** (WETH-USDC or cbBTC-USDC, one swap): 75 (10.8%) → **~9.2 fills/day.**
- The remaining 5 are WETH↔cbBTC, sourceable only via a USDC multi-hop.
- Multi-output-token orders (unsourceable by a single swap): 0.

The overwhelming majority of Dutch_V3 flow is long-tail-token ↔ WETH/USDC — outside Ryze's pools. The
addressable slice (~9–10/day) is in the same ballpark as the Priority-era OQ-5 estimate (~10/day, ~$1.7M/mo),
so migrating does not shrink the opportunity — but it does not grow it either. **Migrating the order type is
necessary to see any flow at all, but by itself it creates no new addressable volume.**

## 3. Exclusivity reality check (critical — this is the real finding)

- **642 / 696 (92.2%)** carry a non-zero `exclusiveFiller`.
- **All 696** carry `exclusivityOverrideBps = 25`. In UniswapX V3 the reactor applies this override **on-chain**
  when `msg.sender != exclusiveFiller`: a non-exclusive filler must deliver the swapper **25 bps more output**
  than the resolved curve to fill. (The SDK's `resolve()` does *not* apply it — it is a reactor-side handicap;
  source-verified in `V3DutchOrder.resolve` + on-chain `ExclusivityLib`.)
- Over the **addressable** subset (80 orders) only **3 distinct exclusive fillers** appear, and one incumbent
  (`0xb2d355…`) wins **75%** (60/80); a second (`0x9b824d…`) wins 13; only **7/80 (~9%) are non-exclusive**.

**Implication:** as an unregistered poller we would have to beat the curve by ≥25 bps to touch the 92% exclusive
flow. Ryze's live all-in cost is ~5–12.5 bps off mid (ARCHITECTURE §OQ-5), so the 25 bps handicap is usually
larger than our entire edge — we lose those races structurally, not on latency. The only openly contestable
slice is the ~9% non-exclusive orders (~0.8 addressable fills/day), and those are gas-races against the same
incumbents. **Polling ≈ near-zero win rate on addressable flow.**

## 4. Decay shape (sizes the decay-wait knob)

Addressable subset (80 orders): output decay is a **single linear segment**, curve span **4 blocks (~8 s on
Base)**, depth **median = max = 250 bps**. So `owed` output falls ~2.5% linearly over ~8 s from `decayStartBlock`.
The decay-wait lever (`maxDecayWaitBlocks`) is worth at most ~4 blocks, and the exclusive filler has first claim
across the whole window — waiting mainly matters for the rare non-exclusive order.

## 5. Verdict & recommended sequencing

1. **Build Phases 1–5** (rebind executor, Dutch_V3 parser/model, block-decay economics, fill-decision strategy +
   timing, config/docs/tests, fork-fill re-verify). This is the correct plumbing regardless — it's where the flow
   is, and it's the prerequisite for RFQ.
2. **Run shadow mode** to confirm the bot now *sees* Dutch_V3 orders and to log would-be P&L / skip reasons on the
   ~9/day addressable slice. Expect shadow to show most addressable orders as "lost to exclusivity."
3. **Phase 6 (RFQ registration) is the actual go-live gate.** Without becoming the `exclusiveFiller` for
   Ryze-priceable pairs, live polling will win ~nothing. Scope RFQ next; do not raise caps or expect live P&L
   from polling alone.
4. On-chain deploy + re-whitelist of the new executor (Phase 1 steps 3) are **owner-key ops** (RUNBOOK §2) — left
   for the owner, not done autonomously.
