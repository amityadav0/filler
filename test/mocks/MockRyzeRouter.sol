// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IRyzeRouter} from "../../src/interfaces/IRyzeRouter.sol";

/// @notice Stand-in for the Ryze router in filler unit tests.
/// @dev Mirrors the observable behaviour the executor relies on: pulls `amountIn` of `tokenIn` from the
///      caller (executor must have approved it) and delivers a configurable output amount of `tokenOut` to
///      `recipient`. Prices/path are accepted but ignored. Must be pre-funded with `tokenOut`.
contract MockRyzeRouter {
    /// @notice Output amount delivered per swap; set by the test to simulate Ryze net-out (incl. spread).
    uint256 public amountOutOverride;

    /// @notice Native value forwarded on the last swap (the Pyth verification fee); asserted by tests.
    uint256 public lastValue;

    function setAmountOut(uint256 amountOut) external {
        amountOutOverride = amountOut;
    }

    function swapExactIn(IRyzeRouter.SwapParams calldata params) external payable returns (uint256 amountOut) {
        lastValue = msg.value;
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        amountOut = amountOutOverride;
        require(amountOut >= params.minAmountOut, "MockRyzeRouter: slippage");
        IERC20(params.tokenOut).transfer(params.recipient, amountOut);
    }
}
