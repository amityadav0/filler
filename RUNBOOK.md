# Ryze UniswapX Filler — Runbook

Operational guide for taking the filler from shadow (M3) to live-capped (M4). Read alongside
[ARCHITECTURE.md](./ARCHITECTURE.md). **Steps that move funds or need an owner key are called out — do not do them
without owner sign-off (ARCHITECTURE §7).**

## 0. Addresses (Base, chainId 8453)

| Role | Address |
|---|---|
| **V3DutchOrderReactor** (verified: SDK mapping = docs = live order `reactor` field) | `0x000000008a8330B5d1F43A62Bf4C673A49f27ba0` |
| MultiHopRouter (`ryzeRouter`) | `0xCA8A097f627ef41Be12EbF7433F5B6b8A114D77b` |
| WeightedPoolQueries (`ryzeQueries`) | `0x14EB47280E7D34d8d826a431025487dad7648711` |
| PythProOracle (`ryzeOracle`) | `0x379dDf0B33aEf387426Bb9d30990A6c8CE3479F2` |
| WETH-USDC pool | `0x22f902cEfcF8b0bEc6489Cb8ac11FdDa9B2aF125` |
| cbBTC-USDC pool | `0x40F3DAaE59BfE03f9Fb019Bb089Bb0C381DE27Cf` |
| Ryze pool owner (whitelist authority) | `0x0A2C3a5b964658EAC71819778A9429F1dd3071C2` |
| **Executor** | ⚠️ **REDEPLOY REQUIRED for Dutch_V3.** The old executor `0x7acBe6faEabE85078D558bb6510D07dd4c40399e` is IMMUTABLY bound to the retired Priority reactor and cannot fill Dutch_V3. Deploy a fresh one bound to the V3DutchOrderReactor (§2, `REACTOR` now defaults to it), whitelist it on the router, then set `addresses.executor` in `bot/config/base.json`. |

> **Order type migrated Priority → Dutch_V3 (2026-07-10).** The Priority reactor `0x0000…De729` is retired for
> this bot (Priority flow on Base is ~3 fills/day vs Dutch_V3 ~85/day). See [DUTCH-V3-AUDIT.md](./DUTCH-V3-AUDIT.md).
> Live fills are gated on RFQ registration (92% of addressable flow is exclusivity-locked to incumbents) — see
> FOLLOWUP Phase RFQ.

Tokens: USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, WETH `0x4200…0006`,
WBTC `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf`. Pyth Lazer feed ids: WETH `631`, USDC `7`, WBTC `397`.

## 1. Environment

Secrets live in the environment, never in committed config:

```bash
export RPC_URL=https://mainnet.base.org          # or a private Base RPC
export BASE_RPC_URL=$RPC_URL                      # forge fork/deploy
# If the private RPC needs an Authorization header (forge/anvil can't send one), run the local injector:
#   UPSTREAM_RPC_URL=http://<host>/ UPSTREAM_RPC_AUTH="Bearer <token>" node scripts/rpc-proxy.mjs &
#   export BASE_RPC_URL=http://127.0.0.1:8552
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

> **OQ-1 (wire format reconciled):** the Pyth Lazer subscribe frame, the signed-CEX message shape, and the single
> shared-blob `pythUpdateData` in `bot/src/payloads/source.ts` match the `limit-order-bot` Go reference
> (`internal/oracle/{pyth_price,cex_oracle}.go`). The router's Pyth verification fee is billed **per non-empty
> update blob** — `verification_fee() × n`, n = non-empty `pythUpdateData` elements (`PythProOracle.sol:344-352`,
> source-verified) — and we send one bundled blob, so `n = 1` and `pythVerificationFeeWei` = the flat
> `verification_fee()`. **Coverage is resolved:** signed prices stream live for USDC (`us1.mainnet.pricing.ryze.pro`)
> and ETH+BTC (`us-signed-price-4tyzr.ondigitalocean.app`) — set BOTH in `RYZE_PRICING_URL`.

## 2. Deploy the executor (owner op — M4 prep)

Recommended signing: an encrypted Foundry keystore (`cast wallet import <name> --interactive`) instead of a raw
`PRIVATE_KEY` env. `OWNER`/`OPERATOR` env are optional and default to the deployer (the one-key test setup —
rotate later with `setOperator` / `transferOwnership`, no redeploy; the router whitelist is on the contract
address and survives key rotation).

```bash
SENDER=$(cast wallet address --account operator)     # keystore name from `cast wallet import`
# dry run first (no --broadcast)
forge script script/DeployExecutor.s.sol --rpc-url $BASE_RPC_URL --account operator --sender $SENDER
# broadcast + verify (deployer == owner ⇒ router pre-approvals happen in the same run)
APPROVE_USDC=true APPROVE_WETH=true APPROVE_WBTC=true \
  forge script script/DeployExecutor.s.sol --rpc-url $BASE_RPC_URL \
  --account operator --sender $SENDER --broadcast --verify
```

Then set the printed address as `addresses.executor` in `bot/config/base.json`.

## 3. Whitelist / approvals (owner op)

- **`pauseDirectSwap` is TRUE on Base (OQ-2 resolved, fork-verified 2026-07-07)** — whitelisting is a HARD
  dependency: the Ryze pool owner (`0x0A2C…`) must call `setWhitelistedIntentSwapper(executor, true)` on the
  router before ANY fill can execute.
- The executor must approve the router for each input token. The deploy script does this for USDC/WETH/WBTC when
  the deployer is the owner; otherwise call `approveRouter(token, type(uint256).max)` from the owner key.

## 4. Dry-run (M2) then shadow (M3)

```bash
cd bot && npm ci
MODE=dryrun npm run dry-run     # quote live orders, log would-be spread; sends nothing
MODE=shadow  npm run shadow      # quote → bid → BUILD fill tx (never sent); logs would-be P&L
```

### 4b. Mainnet-fork fill (go/no-go gate — PASSED 2026-07-07)

`bot/src/forkFill.ts` executes a REAL fill on an anvil fork of Base with nothing mocked: real reactor
(Permit2 pull + callback + `_fill`), real router + oracle verifying LIVE Pyth/signed-CEX payloads, real pool
swap, driven by the bot's own quoter → strategy → submitter:

```bash
anvil --fork-url $RPC_URL --port 8546          # terminal 1
cd bot && PYTH_PRO_ACCESS_TOKEN=... FORK_RPC_URL=http://127.0.0.1:8546 npm run fork-fill
```

Verified result: swapper received EXACTLY the order-owed output (MPS auction math matches the reactor
bit-for-bit), executor kept ~1.1% spread (~$10 on 0.5 WETH), gas ≈ 1.15M (hence `strategy.gasEstimate` = 1.3M).
Re-run after any executor or payload-pipeline change.

Let shadow run ~1 week. Review logs for: bid rate, would-be win P&L, sessionized fees, and the
`skip.*` reasons (`no_spread`, `below_min_profit`, `notional_over_cap`, `exposure_over_cap`,
`input-scaling_unsupported`, `multi-token_outputs`). Use this to answer **OQ-4/OQ-5** (which pairs, sizes vs
band limits) and tune `strategy.spreadCaptureBps` in the config.

## 5. Go live, capped (M4 — requires owner sign-off)

Only after shadow review + sign-off:
1. Confirm caps in `bot/config/base.json` are small: `caps.maxNotionalUsdWadPerFill`,
   `caps.maxOpenExposureUsdWadPerToken`, `caps.maxRevertGasWeiPerHour`; `strategy.minProfitUsdWad` > 0.
2. Fund the `OPERATOR` hot key with a little ETH for gas.
3. Run the live loop (`bot/src/live.ts` — target-block gating, deadline guard, send-time re-quote, reverted-gas
   budget, in-flight exposure holds are all built in):

   ```bash
   export OPERATOR_KEYSTORE=~/.foundry/keystores/operator     # encrypted V3 keystore (cast wallet import)
   export OPERATOR_KEYSTORE_PASSWORD=<password>               # or OPERATOR_PRIVATE_KEY for throwaway tests
   MODE=live npm run live
   ```

4. Verify ONE won fill end-to-end (swapper paid, executor kept spread, `sweep` works), then scale caps.

## 6. Monitoring & safety

- Metrics counters (`bot/src/metrics`): orders seen/quoted/bid, skip reasons, payload cache hits/misses.
  Wire to Prometheus in M5.
- Serialize fills per pool to avoid session drift between quote and fill (ARCHITECTURE §6; M5).
- Kill switch: `setOperator(address(0))` (owner) disables all fills instantly. `sweep`/`sweepNative` recover
  balances to the owner.

## 7. Open questions gating live

OQ-1 resolved (§1: wire format + feed coverage). OQ-2 resolved (§3: `pauseDirectSwap` = true ⇒ whitelist is a
hard owner op). OQ-3 (direct vs intent lane) open but non-blocking — fork fill executed via direct `swapExactIn`.
OQ-4/OQ-5 (pairs & sizes) — resolved by §4 shadow data.
