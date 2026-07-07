// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {RyzeUniswapXExecutor} from "../src/RyzeUniswapXExecutor.sol";
import {IReactor} from "../src/interfaces/IReactor.sol";
import {IWETH} from "../src/interfaces/IWETH.sol";
import {IRyzeRouter} from "../src/interfaces/IRyzeRouter.sol";
import {ResolvedOrder, SignedOrder, OrderInfo, InputToken, OutputToken} from "../src/interfaces/ReactorStructs.sol";

import {MockReactor} from "./mocks/MockReactor.sol";
import {MockRyzeRouter} from "./mocks/MockRyzeRouter.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @title RyzeUniswapXExecutorTest
/// @notice Unit tests for the UniswapX filler executor against a source-faithful mock reactor + mock Ryze router.
/// @dev The mocks reproduce the verified UniswapX `BaseReactor` settlement path (approve-then-transferFrom for
///      ERC20, native `.call` from reactor balance) so these tests exercise the exact on-chain contract the real
///      reactor enforces. A guarded fork check confirms the real Base reactor address is live.
contract RyzeUniswapXExecutorTest is Test {
    RyzeUniswapXExecutor internal executor;
    MockReactor internal reactor;
    MockRyzeRouter internal router;
    MockWETH internal weth;
    MockERC20 internal usdc;

    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal swapper = makeAddr("swapper");
    address internal pool = makeAddr("pool");

    /// @notice PriorityOrderReactor on Base (see ARCHITECTURE.md §2).
    address internal constant BASE_REACTOR = 0x000000001Ec5656dcdB24D90DFa42742738De729;

    uint256 internal constant AMOUNT_IN = 1_000e6; // 1000 USDC
    uint256 internal constant ORDER_OUT = 1e18; // 1 WETH owed to swapper
    uint256 internal constant RYZE_OUT = 1.05e18; // Ryze delivers 1.05 WETH → 0.05 spread

    function setUp() public {
        weth = new MockWETH();
        usdc = new MockERC20("USD Coin", "USDC", 6);
        router = new MockRyzeRouter();
        reactor = new MockReactor();
        executor = new RyzeUniswapXExecutor(
            IReactor(address(reactor)), IRyzeRouter(address(router)), IWETH(address(weth)), owner, operator
        );

        // Swapper holds input and approves the reactor (stands in for the Permit2 pull).
        usdc.mint(swapper, AMOUNT_IN);
        vm.prank(swapper);
        usdc.approve(address(reactor), type(uint256).max);

        // Fund the router with ETH-backed WETH so it can deliver output (and so unwrap works for native fills).
        vm.deal(address(this), 100 ether);
        weth.deposit{value: 100 ether}();
        weth.transfer(address(router), 100 ether);
        router.setAmountOut(RYZE_OUT);
    }

    // --- helpers -------------------------------------------------------------

    function _fillData() internal view returns (bytes memory) {
        return _fillData(0);
    }

    function _fillData(uint256 pythFeeWei) internal view returns (bytes memory) {
        IRyzeRouter.Hop[] memory path = new IRyzeRouter.Hop[](1);
        path[0] = IRyzeRouter.Hop({pool: pool, tokenIn: address(usdc), tokenOut: address(weth)});
        RyzeUniswapXExecutor.FillData memory fd = RyzeUniswapXExecutor.FillData({
            path: path,
            minAmountOut: ORDER_OUT,
            deadline: block.timestamp + 1,
            pythUpdateData: new bytes[](0),
            cexPriceData: new IRyzeRouter.CexPriceData[](0),
            pythFeeWei: pythFeeWei
        });
        return abi.encode(fd);
    }

    function _order(address outputToken) internal view returns (SignedOrder memory) {
        OutputToken[] memory outputs = new OutputToken[](1);
        outputs[0] = OutputToken({token: outputToken, amount: ORDER_OUT, recipient: swapper});
        MockReactor.TestOrder memory o = MockReactor.TestOrder({
            swapper: swapper, nonce: 1, inputToken: address(usdc), inputAmount: AMOUNT_IN, outputs: outputs
        });
        return SignedOrder({order: abi.encode(o), sig: ""});
    }

    // --- fills ---------------------------------------------------------------

    function test_Fill_ERC20Output_swapperPaid_executorKeepsSpread() public {
        vm.prank(operator);
        executor.execute(_order(address(weth)), _fillData());

        assertEq(weth.balanceOf(swapper), ORDER_OUT, "swapper receives resolved output");
        assertEq(weth.balanceOf(address(executor)), RYZE_OUT - ORDER_OUT, "executor keeps spread");
        assertEq(usdc.balanceOf(swapper), 0, "swapper input pulled");
        assertEq(usdc.balanceOf(address(router)), AMOUNT_IN, "router received input");
        // No lingering allowance after the reactor pulled the output.
        assertEq(weth.allowance(address(executor), address(reactor)), 0, "output allowance consumed");
    }

    function test_Fill_forwardsPythFeeToRouter() public {
        uint256 fee = 0.001 ether;
        vm.deal(operator, fee);
        vm.prank(operator);
        executor.execute{value: fee}(_order(address(weth)), _fillData(fee));

        assertEq(router.lastValue(), fee, "router received the pyth verification fee");
        assertEq(address(executor).balance, 0, "no native left in executor");
    }

    function test_Fill_NativeOutput_swapperPaidEth_executorKeepsWethSpread() public {
        uint256 swapperEthBefore = swapper.balance;

        vm.prank(operator);
        executor.execute(_order(address(0)), _fillData());

        assertEq(swapper.balance - swapperEthBefore, ORDER_OUT, "swapper receives native ETH");
        assertEq(weth.balanceOf(address(executor)), RYZE_OUT - ORDER_OUT, "executor keeps WETH spread");
        assertEq(address(executor).balance, 0, "no native dust stuck in executor");
    }

    // --- access control ------------------------------------------------------

    function test_execute_revertsForNonOperator() public {
        vm.expectRevert(RyzeUniswapXExecutor.NotOperator.selector);
        executor.execute(_order(address(weth)), _fillData());
    }

    function test_reactorCallback_revertsOnBatch() public {
        // The callback sources output for orders[0] only; a batch would under-source. Must revert.
        ResolvedOrder[] memory resolved = new ResolvedOrder[](2);
        OutputToken[] memory outputs = new OutputToken[](1);
        outputs[0] = OutputToken({token: address(weth), amount: ORDER_OUT, recipient: swapper});
        for (uint256 i = 0; i < 2; i++) {
            resolved[i] = ResolvedOrder({
                info: OrderInfo(address(reactor), swapper, i, block.timestamp, address(0), ""),
                input: InputToken(IERC20(address(usdc)), AMOUNT_IN, AMOUNT_IN),
                outputs: outputs,
                sig: "",
                hash: bytes32(0)
            });
        }
        vm.prank(address(reactor));
        vm.expectRevert(RyzeUniswapXExecutor.SingleOrderOnly.selector);
        executor.reactorCallback(resolved, _fillData());
    }

    function test_reactorCallback_revertsForNonReactor() public {
        ResolvedOrder[] memory resolved = new ResolvedOrder[](1);
        OutputToken[] memory outputs = new OutputToken[](1);
        outputs[0] = OutputToken({token: address(weth), amount: ORDER_OUT, recipient: swapper});
        resolved[0] = ResolvedOrder({
            info: OrderInfo(address(reactor), swapper, 1, block.timestamp, address(0), ""),
            input: InputToken(IERC20(address(usdc)), AMOUNT_IN, AMOUNT_IN),
            outputs: outputs,
            sig: "",
            hash: bytes32(0)
        });
        vm.expectRevert(RyzeUniswapXExecutor.NotReactor.selector);
        executor.reactorCallback(resolved, _fillData());
    }

    // --- admin ---------------------------------------------------------------

    function test_setOperator() public {
        address newOp = makeAddr("newOperator");
        vm.prank(owner);
        executor.setOperator(newOp);
        assertEq(executor.operator(), newOp);
    }

    function test_setOperator_revertsForNonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        executor.setOperator(address(1));
    }

    function test_sweep_erc20ToOwner() public {
        usdc.mint(address(executor), 500e6);
        vm.prank(owner);
        executor.sweep(IERC20(address(usdc)), 500e6);
        assertEq(usdc.balanceOf(owner), 500e6);
    }

    function test_sweepNative_toOwner() public {
        vm.deal(address(executor), 3 ether);
        vm.prank(owner);
        executor.sweepNative(3 ether);
        assertEq(owner.balance, 3 ether);
    }

    // --- fork guard ----------------------------------------------------------

    /// @notice Confirms the real PriorityOrderReactor is deployed at the documented Base address.
    /// @dev Skips unless BASE_RPC_URL is set. A full signed-order fork fill (Permit2 EIP-712 order signing +
    ///      Ryze Base deployment) is the follow-up integration test built with the M2 SDK tooling.
    function test_Fork_reactorLiveOnBase() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        assertGt(BASE_REACTOR.code.length, 0, "reactor deployed on Base");
    }
}
