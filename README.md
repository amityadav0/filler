# Ryze UniswapX Filler

A filler that wins **UniswapX Priority Orders on Base** by sourcing liquidity from **Ryze SmartShield
pools** — routing external orderflow into Ryze (volume, fees, WBR) while earning filler margin. The on-chain
executor and quoting layer also serve as the reference integration for third-party solvers routing through Ryze.

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the full design, economics, and milestone plan.

## Layout

```
src/
  RyzeUniswapXExecutor.sol      on-chain executor (IReactorCallback)
  interfaces/                   vendored UniswapX interfaces + minimal IRyzeRouter / IWETH
test/
  RyzeUniswapXExecutor.t.sol    unit tests against a source-faithful mock reactor
  mocks/
bot/                            off-chain TypeScript filler (ingestor, quoter, strategy, submitter, …)
```

The contracts are **decoupled from the Ryze source tree**: the executor talks to the router through the
minimal `IRyzeRouter` interface (field-compatible with the deployed Ryze `MultiHopRouter`), so this repo builds
standalone.

## Contracts

```bash
forge build
forge test                     # unit tests (mock reactor + mock Ryze router)
BASE_RPC_URL=... forge test    # also runs the guarded fork check against the live Base reactor
```

Requires [Foundry](https://book.getfoundry.sh/) (solc 0.8.30, via-IR). Submodules: `forge-std`, `openzeppelin-contracts`.

```bash
git clone --recurse-submodules https://github.com/amityadav0/filler.git
# or, after a plain clone:
forge install
```

## Bot

```bash
cd bot
npm install
npm run build                  # typecheck
```

Configure addresses/pools/feeds/caps in `bot/config/base.json`. See [bot/README.md](./bot/README.md).

## Status

| Milestone | State |
|---|---|
| M0 scaffolding | ✅ |
| M1 executor + tests | ✅ |
| M2 quoter + payload-service | ✅ (live feeds wired: Pyth Lazer + both signed-CEX hosts) |
| M3 strategy + submitter (shadow) | ✅ (`MODE=shadow npm run shadow`) |
| **Mainnet-fork fill gate** | ✅ **PASSED 2026-07-07** (`npm run fork-fill` — real fill, nothing mocked; RUNBOOK §4b) |
| M4 live, capped | ⬜ owner ops only: deploy executor + router whitelist (`pauseDirectSwap` is ON) — see [RUNBOOK.md](./RUNBOOK.md) |
| M5 hardening | ⬜ backlog in [FOLLOWUP.md](./FOLLOWUP.md) |

Deploy + go-live steps: **[RUNBOOK.md](./RUNBOOK.md)** · next steps + backlog: **[FOLLOWUP.md](./FOLLOWUP.md)**.

## Key references

| Thing | Where |
|---|---|
| Reactor (Base) | `0x000000001Ec5656dcdB24D90DFa42742738De729` |
| Orders API | `https://api.uniswap.org/v2/orders?orderStatus=open&orderType=Priority&chainId=8453` |
| SDK | `@uniswap/uniswapx-sdk` ≥ 2.1.0-beta.13 (`CosignedPriorityOrder`) |
| Ryze swap entry | ryze-contracts `src/amm/MultiHopRouter.sol` |
| Ryze quotes | ryze-contracts `src/amm/WeightedPoolQueries.sol#querySwapExactIn` |
