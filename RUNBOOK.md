# Ryze UniswapX Filler — Runbook

Operational guide for taking the filler from shadow (M3) to live-capped (M4). Read alongside
[ARCHITECTURE.md](./ARCHITECTURE.md). **Steps that move funds or need an owner key are called out — do not do them
without owner sign-off (ARCHITECTURE §7).**

## 0. Addresses (Base, chainId 8453)

| Role | Address |
|---|---|
| PriorityOrderReactor | `0x000000001Ec5656dcdB24D90DFa42742738De729` |
| MultiHopRouter (`ryzeRouter`) | `0xCA8A097f627ef41Be12EbF7433F5B6b8A114D77b` |
| WeightedPoolQueries (`ryzeQueries`) | `0x14EB47280E7D34d8d826a431025487dad7648711` |
| PythProOracle (`ryzeOracle`) | `0x379dDf0B33aEf387426Bb9d30990A6c8CE3479F2` |
| WETH-USDC pool | `0x22f902cEfcF8b0bEc6489Cb8ac11FdDa9B2aF125` |
| WBTC-USDC pool | `0x40F3DAaE59BfE03f9Fb019Bb089Bb0C381DE27Cf` |
| Ryze pool owner (whitelist authority) | `0x0A2C3a5b964658EAC71819778A9429F1dd3071C2` |
| Executor | _set after deploy (§2)_ |

Tokens: USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, WETH `0x4200…0006`,
WBTC `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf`. Pyth Lazer feed ids: WETH `631`, USDC `7`, WBTC `397`.

## 1. Environment

Secrets live in the environment, never in committed config:

```bash
export RPC_URL=https://mainnet.base.org          # or a private Base RPC
export BASE_RPC_URL=$RPC_URL                      # forge fork/deploy
# payload pipeline (bot):
export PYTH_PRO_ACCESS_TOKEN=<token>                       # Pyth Lazer Bearer token
# signed-CEX WS (subscribe by symbol). Feed is SPLIT across hosts — list BOTH (USDC on one, ETH/BTC on the other):
export RYZE_PRICING_URL=wss://us1.mainnet.pricing.ryze.pro/ws,wss://us-signed-price-4tyzr.ondigitalocean.app/ws
# export PYTH_PRO_STREAM_URLS=wss://...   # optional; defaults to the 3 dourolabs endpoints
# deploy (owner op):
export PRIVATE_KEY=<deployer key>
export OWNER=<owner/admin address>
export OPERATOR=<hot submitter address>
```

When the payload env vars are present the bot uses the real price source; otherwise it falls back to a stub that
throws on use (so nothing runs on fabricated prices).

> **OQ-1 (wire format reconciled):** the Pyth Lazer subscribe frame, the signed-CEX message shape, the single
> shared-blob `pythUpdateData`, and the per-feed Pyth verification fee (`feePerToken × pythFeedCount`) in
> `bot/src/payloads/source.ts` now match the `limit-order-bot` Go reference
> (`internal/oracle/{pyth_price,cex_oracle}.go`, `internal/executor/executor_amm.go`). The remaining live
> dependency is feed **coverage**, not format: mainnet signed-CEX must actually stream ETHUSD/BTCUSD (config lists
> them) before WETH/WBTC fills can price and sign — until then those fetches throw and the order is skipped.

## 2. Deploy the executor (owner op — M4 prep)

```bash
# dry run first
forge script script/DeployExecutor.s.sol --rpc-url $BASE_RPC_URL
# broadcast + verify (deployer = OWNER lets it also pre-approve the router)
APPROVE_USDC=true APPROVE_WETH=true APPROVE_WBTC=true \
  forge script script/DeployExecutor.s.sol --rpc-url $BASE_RPC_URL --broadcast --verify
```

Then set the printed address as `addresses.executor` in `bot/config/base.json`.

## 3. Whitelist / approvals (owner op)

- If `pauseDirectSwap` is enabled on the router (**OQ-2 — confirm on Base**), the Ryze pool owner
  (`0x0A2C…`) must add the executor to `isWhitelistedIntentSwapper`. Do this regardless so a future pause can't
  kill the filler.
- The executor must approve the router for each input token. The deploy script does this for USDC/WETH/WBTC when
  the deployer is the owner; otherwise call `approveRouter(token, type(uint256).max)` from the owner key.

## 4. Dry-run (M2) then shadow (M3)

```bash
cd bot && npm ci
MODE=dryrun npm run dry-run     # quote live orders, log would-be spread; sends nothing
MODE=shadow  npm run shadow      # quote → bid → BUILD fill tx (never sent); logs would-be P&L
```

Let shadow run ~1 week. Review logs for: bid rate, would-be win P&L, sessionized fees, and the
`skip.*` reasons (`no_spread`, `below_min_profit`, `notional_over_cap`, `exposure_over_cap`,
`input-scaling_unsupported`, `multi-token_outputs`). Use this to answer **OQ-4/OQ-5** (which pairs, sizes vs
band limits) and tune `strategy.spreadCaptureBps` in the config.

## 5. Go live, capped (M4 — requires owner sign-off)

Only after shadow review + sign-off:
1. Confirm caps in `bot/config/base.json` are small: `caps.maxNotionalUsdWadPerFill`,
   `caps.maxOpenExposureUsdWadPerToken`, `caps.maxRevertGasWeiPerHour`.
2. Fund the `OPERATOR` hot key with a little ETH for gas.
3. Flip the submitter to live (`send: true`) — currently gated in `bot/src/submitter/index.ts`; the live path is
   intentionally not reachable from `runShadow`. Wire the reverted-gas budget (`createGasBudget`) into the send
   path so losing bids stop once `maxRevertGasWeiPerHour` is hit.
4. Verify ONE won fill end-to-end (swapper paid, executor kept spread, `sweep` works), then scale caps.

## 6. Monitoring & safety

- Metrics counters (`bot/src/metrics`): orders seen/quoted/bid, skip reasons, payload cache hits/misses.
  Wire to Prometheus in M5.
- Serialize fills per pool to avoid session drift between quote and fill (ARCHITECTURE §6; M5).
- Kill switch: `setOperator(address(0))` (owner) disables all fills instantly. `sweep`/`sweepNative` recover
  balances to the owner.

## 7. Open questions gating live

OQ-1 (payload client reconcile — §1), OQ-2 (`pauseDirectSwap` on Base — §3), OQ-3 (direct vs intent lane),
OQ-4/OQ-5 (pairs & sizes — resolved by §4 shadow data).
