// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IReactor} from "./interfaces/IReactor.sol";
import {IReactorCallback} from "./interfaces/IReactorCallback.sol";
import {ResolvedOrder, SignedOrder, OutputToken} from "./interfaces/ReactorStructs.sol";
import {IWETH} from "./interfaces/IWETH.sol";
import {IRyzeRouter} from "./interfaces/IRyzeRouter.sol";

/// @title RyzeUniswapXExecutor
/// @notice Fills UniswapX Priority Orders by sourcing liquidity from Ryze SmartShield pools.
/// @dev The reactor pulls the swapper's input tokens to this contract, then calls {reactorCallback}. During the
///      callback this contract swaps the input through the Ryze router (carrying fresh Pyth/CEX price payloads
///      supplied off-chain), then makes each resolved output available to the reactor:
///      ERC20 outputs are approved to the reactor (it pulls them via `transferFrom` in `_fill`); native-ETH
///      outputs (`token == address(0)`) are unwrapped from WETH and sent to the reactor, which pays the
///      recipient from its own balance. Any leftover output is spread kept by this contract (the filler margin).
///      No pricing logic lives here — economics are decided off-chain; the router's `minAmountOut` and the
///      reactor's atomic output check are the safety rails.
contract RyzeUniswapXExecutor is IReactorCallback, Ownable {
    using SafeERC20 for IERC20;

    /// @notice UniswapX reactor this executor fills for (PriorityOrderReactor on Base).
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    IReactor public immutable reactor;

    /// @notice Ryze multi-hop swap router used to source output liquidity.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    IRyzeRouter public immutable router;

    /// @notice Wrapped native token (WETH on Base) used to settle native-ETH outputs.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    IWETH public immutable weth;

    /// @notice Address permitted to submit fills via {execute}. The off-chain submitter's hot key.
    address public operator;

    /// @notice UniswapX sentinel for a native-ETH output token.
    address internal constant NATIVE = address(0);

    /// @notice Decoded callback payload describing how to source the order's output through Ryze.
    /// @param path Ryze swap path (hops); its last hop's `tokenOut` is the token this contract receives.
    /// @param minAmountOut Router-side slippage floor for the swap.
    /// @param deadline Router-side swap deadline.
    /// @param pythUpdateData Pyth Lazer price update blobs for the pool assets (freshness-checked on-chain).
    /// @param cexPriceData Signed CEX prices for oracle verification.
    /// @param pythFeeWei Native fee to forward to the router for on-chain Pyth verification: the router forwards
    ///        it to `PythProOracle.updatePriceFeedsArray{value: msg.value}`, which requires
    ///        `msg.value >= pythLazer.verification_fee() * (price feeds in the update)`. Lazer bundles every
    ///        subscribed feed into ONE blob, so the count is the number of feeds carried, NOT the length of the
    ///        `pythUpdateData` array (which is 1). Any excess is NOT refunded, so this must be exact. The executor
    ///        forwards it from its own ETH balance.
    struct FillData {
        IRyzeRouter.Hop[] path;
        uint256 minAmountOut;
        uint256 deadline;
        bytes[] pythUpdateData;
        IRyzeRouter.CexPriceData[] cexPriceData;
        uint256 pythFeeWei;
    }

    /// @notice Emitted when the operator is changed.
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);

    /// @notice Emitted for each output made available to the reactor during a fill.
    event OutputSettled(address indexed token, uint256 amount, bool native);

    error NotOperator();
    error NotReactor();
    error EmptyOrders();
    error EmptyPath();
    error NativeTransferFailed();

    /// @param _reactor UniswapX reactor to fill for.
    /// @param _router Ryze router.
    /// @param _weth Wrapped native token used for native-output settlement.
    /// @param _owner Contract owner (admin).
    /// @param _operator Initial fill operator.
    constructor(IReactor _reactor, IRyzeRouter _router, IWETH _weth, address _owner, address _operator)
        Ownable(_owner)
    {
        reactor = _reactor;
        router = _router;
        weth = _weth;
        operator = _operator;
        emit OperatorUpdated(address(0), _operator);
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyReactor() {
        if (msg.sender != address(reactor)) revert NotReactor();
        _;
    }

    /// @notice Submit a fill for a single signed Priority Order.
    /// @param order The signed UniswapX order to fill.
    /// @param fillData ABI-encoded {FillData} describing the Ryze swap that sources the output.
    /// @dev Payable so the operator can attach the exact Pyth verification fee for this fill; the executor may
    ///      also pay it from a pre-funded ETH balance. Not forwarded to the reactor — it is spent inside the
    ///      callback by {reactorCallback} when it calls the router.
    function execute(SignedOrder calldata order, bytes calldata fillData) external payable onlyOperator {
        reactor.executeWithCallback(order, fillData);
    }

    /// @inheritdoc IReactorCallback
    /// @dev Called by the reactor mid-fill, after the swapper's input tokens have been transferred here.
    function reactorCallback(ResolvedOrder[] calldata resolvedOrders, bytes calldata callbackData)
        external
        onlyReactor
    {
        if (resolvedOrders.length == 0) revert EmptyOrders();
        ResolvedOrder calldata order = resolvedOrders[0];

        FillData memory fillData = abi.decode(callbackData, (FillData));
        if (fillData.path.length == 0) revert EmptyPath();

        // Source the output by swapping the order's input through Ryze, keeping the proceeds in this contract.
        address tokenIn = address(order.input.token);
        address tokenOut = fillData.path[fillData.path.length - 1].tokenOut;
        IERC20(tokenIn).forceApprove(address(router), order.input.amount);
        // Forward the Pyth verification fee: the router relays it to the oracle, which reverts without it.
        // Excess is not refunded by the oracle, so the caller sets `pythFeeWei` exactly.
        router.swapExactIn{value: fillData.pythFeeWei}(
            IRyzeRouter.SwapParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                amountIn: order.input.amount,
                minAmountOut: fillData.minAmountOut,
                path: fillData.path,
                deadline: fillData.deadline,
                recipient: address(this),
                pythUpdateData: fillData.pythUpdateData,
                cexPriceData: fillData.cexPriceData
            })
        );

        // Make every resolved output available to the reactor for settlement.
        _settleOutputs(resolvedOrders);
    }

    /// @dev Approve ERC20 outputs to the reactor and fund native-ETH outputs to the reactor.
    function _settleOutputs(ResolvedOrder[] calldata resolvedOrders) internal {
        uint256 nativeOwed;
        for (uint256 i = 0; i < resolvedOrders.length; i++) {
            OutputToken[] calldata outputs = resolvedOrders[i].outputs;
            for (uint256 j = 0; j < outputs.length; j++) {
                OutputToken calldata output = outputs[j];
                if (output.token == NATIVE) {
                    nativeOwed += output.amount;
                    emit OutputSettled(NATIVE, output.amount, true);
                } else {
                    // Reactor pulls each output via transferFrom in _fill; increment allowance so
                    // repeated tokens across outputs accumulate correctly.
                    IERC20(output.token).safeIncreaseAllowance(address(reactor), output.amount);
                    emit OutputSettled(output.token, output.amount, false);
                }
            }
        }

        if (nativeOwed > 0) {
            // The swap delivered wrapped native (WETH); unwrap and forward ETH so the reactor can pay recipients.
            weth.withdraw(nativeOwed);
            (bool ok,) = address(reactor).call{value: nativeOwed}("");
            if (!ok) revert NativeTransferFailed();
        }
    }

    // --- Admin ---------------------------------------------------------------

    /// @notice Update the fill operator.
    function setOperator(address newOperator) external onlyOwner {
        emit OperatorUpdated(operator, newOperator);
        operator = newOperator;
    }

    /// @notice Pre-approve the router to spend `token` (avoids a per-fill approval).
    function approveRouter(IERC20 token, uint256 amount) external onlyOwner {
        token.forceApprove(address(router), amount);
    }

    /// @notice Sweep an ERC20 balance (accumulated filler margin) to the owner.
    function sweep(IERC20 token, uint256 amount) external onlyOwner {
        token.safeTransfer(owner(), amount);
    }

    /// @notice Sweep a native-ETH balance to the owner.
    function sweepNative(uint256 amount) external onlyOwner {
        (bool ok,) = owner().call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }

    /// @notice Accept ETH (WETH unwraps, reactor refunds of excess native).
    receive() external payable {}
}
