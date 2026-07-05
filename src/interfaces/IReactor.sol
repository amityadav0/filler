// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SignedOrder} from "./ReactorStructs.sol";

/// @notice Minimal vendored copy of UniswapX `IReactor.sol`.
/// @dev Source: github.com/Uniswap/UniswapX (src/interfaces/IReactor.sol).
interface IReactor {
    /// @notice Execute a single order.
    function execute(SignedOrder calldata order) external payable;

    /// @notice Execute a single order using the fill contract's callback to source liquidity.
    /// @param order The order to execute.
    /// @param callbackData Opaque data forwarded to the fill contract's `reactorCallback`.
    function executeWithCallback(SignedOrder calldata order, bytes calldata callbackData) external payable;

    /// @notice Execute a batch of orders.
    function executeBatch(SignedOrder[] calldata orders) external payable;

    /// @notice Execute a batch of orders using the fill contract's callback to source liquidity.
    function executeBatchWithCallback(SignedOrder[] calldata orders, bytes calldata callbackData) external payable;
}
