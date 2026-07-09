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
///      Usage — encrypted keystore (recommended; created via `cast wallet import <name> --interactive`):
///        forge script script/DeployExecutor.s.sol --rpc-url $BASE_RPC_URL \
///          --account <name> --sender $(cast wallet address --account <name>) --broadcast --verify
///      Usage — raw key env (legacy):
///        PRIVATE_KEY=0x... forge script script/DeployExecutor.s.sol --rpc-url $BASE_RPC_URL --broadcast --verify
///      Omit --broadcast for a dry run.
///
///      Env (all optional): OWNER, OPERATOR (both default to the deployer — the one-key test setup;
///      rotate later with setOperator/transferOwnership, no redeploy); REACTOR, RYZE_ROUTER, WETH
///      (default to Base mainnet); APPROVE_USDC / APPROVE_WETH / APPROVE_WBTC = true to pre-approve
///      those tokens to the router (max allowance; runs only when the deployer is the owner).
contract DeployExecutor is Script {
    // Base mainnet defaults.
    address constant DEFAULT_REACTOR = 0x000000001Ec5656dcdB24D90DFa42742738De729;
    address constant DEFAULT_ROUTER = 0xCA8A097f627ef41Be12EbF7433F5B6b8A114D77b;
    address constant DEFAULT_WETH = 0x4200000000000000000000000000000000000006;

    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;

    /// @dev Forge's default script sender — seeing it as the deployer means the caller forgot `--sender`
    ///      alongside `--account`, and the owner-gated pre-approvals would silently misfire.
    address constant FOUNDRY_DEFAULT_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    function run() external returns (RyzeUniswapXExecutor executor) {
        // Deployer = the broadcasting account. Two signing flows:
        //   - PRIVATE_KEY env set → derive the address and broadcast with the raw key (legacy);
        //   - otherwise → keystore flow: forge signs via `--account <name>`, and `--sender` makes msg.sender the
        //     broadcaster. Gate the owner-only pre-approvals on THIS address, never on bare `msg.sender` under
        //     the raw-key flow (startBroadcast(pk) does not change the script's msg.sender).
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer = pk != 0 ? vm.addr(pk) : msg.sender;
        require(
            deployer != FOUNDRY_DEFAULT_SENDER, "keystore flow: pass --sender $(cast wallet address --account <name>)"
        );

        address owner = vm.envOr("OWNER", deployer);
        address operator = vm.envOr("OPERATOR", deployer);
        address reactor = vm.envOr("REACTOR", DEFAULT_REACTOR);
        address router = vm.envOr("RYZE_ROUTER", DEFAULT_ROUTER);
        address weth = vm.envOr("WETH", DEFAULT_WETH);

        require(owner != address(0), "OWNER unset");
        require(operator != address(0), "OPERATOR unset");

        if (pk != 0) {
            vm.startBroadcast(pk);
        } else {
            vm.startBroadcast();
        }

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
