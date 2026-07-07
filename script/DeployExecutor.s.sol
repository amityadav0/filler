// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RyzeUniswapXExecutor} from "../src/RyzeUniswapXExecutor.sol";
import {IReactor} from "../src/interfaces/IReactor.sol";
import {IWETH} from "../src/interfaces/IWETH.sol";
import {IRyzeRouter} from "../src/interfaces/IRyzeRouter.sol";

/// @title DeployExecutor
/// @notice Deploys {RyzeUniswapXExecutor} to Base and (optionally) pre-approves the router for the input tokens.
/// @dev Reads all addresses from the environment so nothing is hard-coded. Defaults match the Base deployment
///      (see ARCHITECTURE.md §2 and the ryze-base-deployment note). After running this:
///        1. set the deployed address as `executor` in bot/config/base.json;
///        2. have the Ryze pool owner whitelist the executor on the router if `pauseDirectSwap` is set (OQ-2);
///        3. do NOT enable live sends until owner sign-off (M4).
///
///      Usage (dry run):
///        forge script script/DeployExecutor.s.sol --rpc-url $BASE_RPC_URL
///      Broadcast:
///        forge script script/DeployExecutor.s.sol --rpc-url $BASE_RPC_URL --broadcast --verify
///
///      Required env: PRIVATE_KEY (deployer), OWNER, OPERATOR.
///      Optional env (default to Base mainnet): REACTOR, RYZE_ROUTER, WETH.
///      Optional: APPROVE_TOKENS = comma-free repeated via APPROVE_TOKEN_0..N is avoided; instead set
///      APPROVE_USDC / APPROVE_WETH / APPROVE_WBTC = true to pre-approve those known tokens (max allowance).
contract DeployExecutor is Script {
    // Base mainnet defaults.
    address constant DEFAULT_REACTOR = 0x000000001Ec5656dcdB24D90DFa42742738De729;
    address constant DEFAULT_ROUTER = 0xCA8A097f627ef41Be12EbF7433F5B6b8A114D77b;
    address constant DEFAULT_WETH = 0x4200000000000000000000000000000000000006;

    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;

    function run() external returns (RyzeUniswapXExecutor executor) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address owner = vm.envAddress("OWNER");
        address operator = vm.envAddress("OPERATOR");
        address reactor = vm.envOr("REACTOR", DEFAULT_REACTOR);
        address router = vm.envOr("RYZE_ROUTER", DEFAULT_ROUTER);
        address weth = vm.envOr("WETH", DEFAULT_WETH);

        require(owner != address(0), "OWNER unset");
        require(operator != address(0), "OPERATOR unset");

        // The address broadcasting the txs (= PRIVATE_KEY's address). Gate the owner-only pre-approvals on THIS,
        // not `msg.sender`: inside a forge script `msg.sender` is the script's caller (default sender), which is
        // unaffected by `startBroadcast(pk)` — using it would skip the approvals even when the deployer is owner.
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        executor = new RyzeUniswapXExecutor(IReactor(reactor), IRyzeRouter(router), IWETH(weth), owner, operator);
        console2.log("RyzeUniswapXExecutor deployed at:", address(executor));

        // Pre-approve the router for the input tokens the filler expects to receive (owner-only; deployer must
        // be `owner` for these to succeed — otherwise run approveRouter separately from the owner key).
        if (deployer == owner) {
            if (vm.envOr("APPROVE_USDC", false)) executor.approveRouter(IERC20(USDC), type(uint256).max);
            if (vm.envOr("APPROVE_WETH", false)) executor.approveRouter(IERC20(weth), type(uint256).max);
            if (vm.envOr("APPROVE_WBTC", false)) executor.approveRouter(IERC20(WBTC), type(uint256).max);
        }

        vm.stopBroadcast();

        console2.log("owner:   ", owner);
        console2.log("operator:", operator);
        console2.log("reactor: ", reactor);
        console2.log("router:  ", router);
        console2.log("weth:    ", weth);
    }
}
