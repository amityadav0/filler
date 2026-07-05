// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ResolvedOrder} from "./ReactorStructs.sol";

/// @notice Minimal vendored copy of UniswapX `IReactorCallback.sol`.
/// @dev Source: github.com/Uniswap/UniswapX (src/interfaces/IReactorCallback.sol). The reactor calls this on
///      the fill contract mid-`executeWithCallback`, after pulling the swapper's input tokens to the fill
///      contract and before settling outputs. The fill contract must end the call with every resolved output
///      amount available to the reactor (ERC20: approved to the reactor; native: funded to the reactor).
interface IReactorCallback {
    /// @notice Called by the reactor during an `executeWithCallback` fill.
    /// @param resolvedOrders The orders resolved to concrete input/output amounts.
    /// @param callbackData The opaque data passed to `executeWithCallback`.
    function reactorCallback(ResolvedOrder[] calldata resolvedOrders, bytes calldata callbackData) external;
}
