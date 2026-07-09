// Mainnet-fork fill harness: proves the WHOLE filler path executes against real Base state before M4.
//
// Run against an anvil fork of Base (see bot/README.md / RUNBOOK §4):
//   anvil --fork-url $RPC_URL --port 8546
//   PYTH_PRO_ACCESS_TOKEN=... npm run fork-fill
//
// What it exercises — everything a live fill touches, with NOTHING mocked:
//   real PriorityOrderReactor (Permit2 pull + reactorCallback + _fill), real MultiHopRouter + PythProOracle
//   (signature verification of LIVE Pyth Lazer + signed-CEX payloads), real WeightedPool swap, and the bot's own
//   ingestor-parse → quoter → strategy → submitter pipeline (send = true). The only synthetic ingredient is the
//   order itself: a self-signed CosignedPriorityOrder (cosigner = 0, so no cosignature is required — reactor
//   source-verified) selling WETH for USDC from a funded anvil account.
//
// Go/no-go gate: if this fill lands (swapper paid exactly what the order owes, executor keeps the spread), the
// same bytecode + payload pipeline works on mainnet.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Contract, ContractFactory, JsonRpcProvider, Wallet, ZeroAddress } from "ethers";
import sdkPkg from "@uniswap/uniswapx-sdk";
import { BigNumber } from "@ethersproject/bignumber";
import { loadConfig } from "./config.js";
import { parsePriorityOrder } from "./ingestor/index.js";
import { createQuoter } from "./quoter/index.js";
import { decideBid, type BidContext } from "./strategy/index.js";
import { usdWad } from "./strategy/economics.js";
import { createSubmitter } from "./submitter/index.js";
import {
  createCexWsClient,
  createPythLazerWsClient,
  createRyzeSignedPriceSource,
} from "./payloads/source.js";
import type { Address } from "./types.js";

const { PriorityOrderBuilder } = sdkPkg;

// Default anvil dev accounts (0 = executor owner, 1 = operator/submitter). The swapper is a FRESH random key:
// the well-known anvil dev addresses have EIP-7702 delegations on real Base mainnet (their keys are public), so
// Permit2 sees code at the address and takes the EIP-1271 path instead of ECDSA — the permit signature would
// always fail. A random key has no mainnet history, so ecrecover applies.
const KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  operator: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
};

/** Signed-CEX hosts (feed is split: USDC on one, ETH/BTC on the other — RUNBOOK §1). Env overrides. */
const DEFAULT_CEX_URLS = [
  "wss://us1.mainnet.pricing.ryze.pro/ws",
  "wss://us-signed-price-4tyzr.ondigitalocean.app/ws",
];

const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RYZE_POOL_OWNER = "0x0A2C3a5b964658EAC71819778A9429F1dd3071C2";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];
const WETH_ABI = [...ERC20_ABI, "function deposit() payable"];
const ROUTER_ABI = [
  "function pauseDirectSwap() view returns (bool)",
  "function isWhitelistedIntentSwapper(address) view returns (bool)",
  "function setWhitelistedIntentSwapper(address, bool)",
];
const ORACLE_ABI = ["function pythLazer() view returns (address)"];
const PYTH_LAZER_ABI = ["function verification_fee() view returns (uint256)"];

/** Recursively convert ethers-v5 BigNumbers (from the SDK's permitData) into bigints for v6 signTypedData. */
function normalizeTypedValues(v: unknown): unknown {
  if (v && typeof v === "object") {
    if ((v as { _isBigNumber?: boolean })._isBigNumber) return BigInt((v as { toString(): string }).toString());
    if (Array.isArray(v)) return v.map(normalizeTypedValues);
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, normalizeTypedValues(x)]));
  }
  return v;
}

async function main(): Promise<void> {
  const rpc = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8546";
  const provider = new JsonRpcProvider(rpc);
  const net = await provider.getNetwork();
  if (net.chainId !== 8453n) throw new Error(`expected Base fork (8453), got chainId ${net.chainId}`);

  const config = loadConfig("base");
  const { reactor, ryzeRouter, ryzeQueries, ryzeOracle, weth: WETH, permit2 } = config.addresses;

  const owner = new Wallet(KEYS.owner, provider);
  const operator = new Wallet(KEYS.operator, provider);
  const swapper = Wallet.createRandom().connect(provider);
  await provider.send("anvil_setBalance", [swapper.address, "0x8AC7230489E80000"]); // 10 ETH
  const log = (m: string) => console.log(`[fork-fill] ${m}`);

  // EXECUTOR_ADDRESS: exercise the REAL deployed executor (and the real router whitelist) instead of deploying a
  // fresh one — the final pre-live gate. Its on-chain operator is impersonated to sign the fill.
  const execOverride = process.env.EXECUTOR_ADDRESS as Address | undefined;

  // --- 1+2. Executor: use the REAL deployed one when EXECUTOR_ADDRESS is set (final pre-live gate: exercises
  // the on-chain whitelist and the exact deployed bytecode); otherwise deploy fresh from the forge artifact and
  // whitelist it by impersonating the pool owner.
  let executor: Address;
  let fillSigner = operator as unknown as import("ethers").Signer;
  const router = new Contract(ryzeRouter, ROUTER_ABI, provider);
  if (execOverride) {
    executor = execOverride;
    const realOperator = (await new Contract(executor, ["function operator() view returns (address)"], provider).operator()) as string;
    await provider.send("anvil_impersonateAccount", [realOperator]);
    await provider.send("anvil_setBalance", [realOperator, "0x8AC7230489E80000"]);
    fillSigner = await provider.getSigner(realOperator);
    log(`using REAL executor ${executor}, impersonating its operator ${realOperator}`);
    const wl = (await router.isWhitelistedIntentSwapper(executor)) as boolean;
    log(`router whitelist for executor: ${wl} (must be true — no impersonated whitelist in this mode)`);
    if (!wl) throw new Error("real executor is NOT whitelisted on the router");
  } else {
    const artifactPath = join(dirname(fileURLToPath(import.meta.url)), "../../out/RyzeUniswapXExecutor.sol/RyzeUniswapXExecutor.json");
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as { abi: unknown[]; bytecode: { object: string } };
    const factory = new ContractFactory(artifact.abi as never, artifact.bytecode.object, owner);
    const executorContract = await (await factory.deploy(reactor, ryzeRouter, WETH, owner.address, operator.address)).waitForDeployment();
    executor = (await executorContract.getAddress()) as Address;
    log(`executor deployed at ${executor}`);

    const paused = (await router.pauseDirectSwap()) as boolean;
    log(`router.pauseDirectSwap = ${paused} (OQ-2)`);
    if (paused) {
      await provider.send("anvil_impersonateAccount", [RYZE_POOL_OWNER]);
      await provider.send("anvil_setBalance", [RYZE_POOL_OWNER, "0x1000000000000000000"]);
      const ownerSigner = await provider.getSigner(RYZE_POOL_OWNER);
      await (await (router.connect(ownerSigner) as Contract).setWhitelistedIntentSwapper(executor, true)).wait();
      log(`whitelisted executor on router (impersonated pool owner) — M4 hard dependency confirmed`);
    }
  }

  // --- 3. Fund the swapper: wrap ETH → WETH, approve Permit2 --------------------------------------------------
  const AMOUNT_IN = 500_000_000_000_000_000n; // 0.5 WETH
  const wethC = new Contract(WETH, WETH_ABI, swapper);
  await (await wethC.deposit({ value: AMOUNT_IN })).wait();
  await (await wethC.approve(permit2, 2n ** 256n - 1n)).wait();
  log(`swapper funded with 0.5 WETH, Permit2 approved`);

  // --- 4. Live payloads: both signed-CEX hosts + Pyth Lazer, covering EVERY subscribed feed --------------------
  const pythToken = process.env.PYTH_PRO_ACCESS_TOKEN;
  if (!pythToken) throw new Error("PYTH_PRO_ACCESS_TOKEN required (live Pyth Lazer payloads)");
  const cexUrls = process.env.RYZE_PRICING_URL?.split(",").map((s) => s.trim()).filter(Boolean) ?? DEFAULT_CEX_URLS;
  const feedIdByToken: Record<string, string> = {};
  const feedIds = new Set<number>();
  for (const p of config.pools) {
    for (const [token, feedId] of Object.entries(p.feedIds)) {
      feedIdByToken[token.toLowerCase()] = feedId;
      feedIds.add(Number(feedId));
    }
  }
  const allAssets = [...new Set(config.pools.flatMap((p) => p.tokens.map((t) => t.toLowerCase())))] as Address[];

  const cexClient = createCexWsClient({ urls: cexUrls, symbols: config.oracle.cexAssets, log });
  const pythClient = createPythLazerWsClient({
    feedIds: [...feedIds],
    accessToken: pythToken,
    ...(process.env.PYTH_PRO_STREAM_URLS ? { endpoints: process.env.PYTH_PRO_STREAM_URLS.split(",") } : {}),
    log,
  });
  cexClient.start();
  pythClient.start();
  const source = createRyzeSignedPriceSource({ cexClient, pythClient, feedIdByToken });

  // Wait for both hot caches to cover every subscribed asset (WETH + USDC + WBTC).
  const fetchAll = async () => source.fetch(allAssets);
  let payloads = await (async () => {
    for (let i = 0; i < 60; i++) {
      try {
        return await fetchAll();
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error("payload feeds did not become ready within 30s");
  })();
  log(`payloads ready: ${payloads.cexPriceData.length} signed CEX prices, ${payloads.pythUpdateData.length} pyth blob(s)`);

  // --- 5. Quote the Ryze leg exactly as the bot would (session-aware, from = executor) ------------------------
  const quoter = createQuoter({ provider, queriesAddress: ryzeQueries as Address, executorAddress: executor, pools: config.pools });
  const quote = await quoter.quoteExactIn(WETH as Address, USDC, AMOUNT_IN, payloads);
  if (!quote) throw new Error("no Ryze path for WETH->USDC");
  log(`ryze quote: 0.5 WETH -> ${quote.netAmountOut} USDC (wbr=${quote.wbrCredit} wbf=${quote.sessionizedWbf})`);

  // --- 6. Build + sign the priority order (baseline = 98% of quote ⇒ 2% raw spread) ---------------------------
  const startBlock = BigInt(await provider.getBlockNumber());
  const baselineOut = (quote.netAmountOut * 98n) / 100n;
  const order = new PriorityOrderBuilder(8453, reactor, permit2)
    .cosigner(ZeroAddress)
    .auctionStartBlock(BigNumber.from(startBlock))
    .baselinePriorityFeeWei(BigNumber.from(0))
    .cosignerData({ auctionTargetBlock: BigNumber.from(startBlock) })
    .cosignature("0x")
    .input({ token: WETH, amount: BigNumber.from(AMOUNT_IN), mpsPerPriorityFeeWei: BigNumber.from(0) })
    .output({ token: USDC, amount: BigNumber.from(baselineOut), mpsPerPriorityFeeWei: BigNumber.from(1), recipient: swapper.address })
    .deadline(Math.floor(Date.now() / 1000) + 300)
    .swapper(swapper.address)
    .nonce(BigNumber.from(Date.now()))
    .build();

  const pd = order.permitData();
  const signature = (await swapper.signTypedData(
    pd.domain as never,
    pd.types as never,
    normalizeTypedValues(pd.values) as never,
  )) as `0x${string}`;
  const parsed = parsePriorityOrder(
    { orderHash: order.hash(), encodedOrder: order.serialize() as `0x${string}`, signature },
    8453,
    WETH as Address,
  );
  log(`order built + permit-signed: baselineOut=${parsed.outputs[0]!.amount} USDC, startBlock=${startBlock}`);

  // --- 7. Strategy: pick the priority-fee bid exactly as the live loop would ----------------------------------
  const priceOf = (t: string) => payloads.prices.find((p) => p.token.toLowerCase() === t.toLowerCase())?.priceWad;
  const block = await provider.getBlock("latest");
  const ctx: BidContext = {
    priceOutWad: priceOf(USDC)!,
    decimalsOut: 6,
    nativePriceWad: priceOf(WETH)!,
    gasEstimate: BigInt(config.strategy.gasEstimate),
    baseFeeWei: block?.baseFeePerGas ?? 0n,
    spreadCaptureBps: config.strategy.spreadCaptureBps,
    improvingShadeBps: config.strategy.improvingDirectionShadeBps,
    worseningShadeBps: config.strategy.worseningDirectionShadeBps,
    maxBidWei: BigInt(config.strategy.maxBidPriorityFeeWei),
    minProfitUsdWad: BigInt(config.strategy.minProfitUsdWad),
    maxNotionalUsdWad: BigInt(config.caps.maxNotionalUsdWadPerFill),
    notionalUsdWad: usdWad(AMOUNT_IN, 18, priceOf(WETH)!),
  };
  const bid = decideBid(parsed, quote, ctx);
  if (bid.kind === "skip") throw new Error(`strategy skipped: ${bid.reason}`);
  const d = bid.decision;
  log(`bid: ${d.bidWei} wei tip, owed=${d.orderOwedOut} USDC, keep=${d.capturedSpreadOut} USDC (~$${Number(d.expectedProfitUsdWad / 10n ** 12n) / 1e6})`);

  // --- 8. Real Pyth verification fee from the forked oracle → exact pythFeeWei --------------------------------
  const oracle = new Contract(ryzeOracle, ORACLE_ABI, provider);
  const pythLazerAddr = (await oracle.pythLazer()) as string;
  const verificationFee = (await new Contract(pythLazerAddr, PYTH_LAZER_ABI, provider).verification_fee()) as bigint;
  log(`pythLazer.verification_fee = ${verificationFee} wei (config placeholder was ${config.oracle.pythVerificationFeeWei})`);

  // --- 9. Refetch payloads at send time, warp the fork clock to now, and SEND the fill ------------------------
  payloads = await fetchAll(); // freshness: signed-CEX timestamps must be within the oracle's tTolerance of block.timestamp
  const latest = await provider.getBlock("latest");
  // The oracle requires cexPrice.timestamp (ms) <= block.timestamp*1000 <= cexPrice.timestamp + tTolerance.
  // Warp to ceil(now)+1 so the block lands just AFTER the signed price (floor(now) would put the block-ms
  // BEFORE the price's sub-second timestamp → StalePrice "price from the future").
  const warpTo = Math.max(Math.ceil(Date.now() / 1000) + 1, Number(latest!.timestamp) + 1);
  await provider.send("evm_setNextBlockTimestamp", [warpTo]);

  const nonEmptyBlobs = payloads.pythUpdateData.filter((b) => b && b !== "0x").length;
  const submitter = createSubmitter({ executor, chainId: 8453, signer: fillSigner });
  const usdcBefore = (await new Contract(USDC, ERC20_ABI, provider).balanceOf(swapper.address)) as bigint;

  const outcome = await submitter.submit(
    {
      encodedOrder: parsed.encodedOrder,
      signature: parsed.signature,
      path: quote.path,
      minAmountOut: d.orderOwedOut,
      deadline: parsed.deadline,
      pythUpdateData: payloads.pythUpdateData,
      cexPriceData: payloads.cexPriceData,
      pythFeeWei: verificationFee * BigInt(nonEmptyBlobs),
      bidWei: d.bidWei,
      baseFeeWei: ctx.baseFeeWei,
      gasLimit: 3_000_000n, // generous for the fork run; the receipt's gasUsed calibrates config.strategy.gasEstimate
    },
    true,
  );
  if (!outcome.sent || !outcome.txHash) throw new Error("submitter did not send");
  const receipt = await provider.waitForTransaction(outcome.txHash, 1, 30_000);
  if (!receipt || receipt.status !== 1) throw new Error(`fill tx reverted: ${outcome.txHash}`);
  log(`fill LANDED: tx=${outcome.txHash} gasUsed=${receipt.gasUsed} effGasPrice=${receipt.gasPrice}`);

  // --- 10. Assert settlement: swapper paid what the order owes, executor keeps the spread ---------------------
  const usdcC = new Contract(USDC, ERC20_ABI, provider);
  const swapperGot = ((await usdcC.balanceOf(swapper.address)) as bigint) - usdcBefore;
  const executorKeeps = (await usdcC.balanceOf(executor)) as bigint;
  const executorWeth = (await wethC.balanceOf(executor)) as bigint;
  log(`swapper received ${swapperGot} USDC (owed ${d.orderOwedOut})`);
  log(`executor keeps  ${executorKeeps} USDC spread; residual WETH=${executorWeth}`);

  if (swapperGot < d.orderOwedOut) throw new Error("ASSERT FAIL: swapper received less than owed");
  if (executorKeeps <= 0n) throw new Error("ASSERT FAIL: executor kept no spread");
  const gasEth = receipt.gasUsed * (receipt.gasPrice ?? 0n);
  log(`P&L: spread=${executorKeeps} USDC vs gas=${gasEth} wei ETH — GO for mainnet ✅`);

  cexClient.close();
  pythClient.close();
}

main().catch((err) => {
  console.error(`[fork-fill] FAILED: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
