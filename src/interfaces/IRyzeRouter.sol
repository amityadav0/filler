// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IRyzeRouter
/// @notice Minimal interface for the Ryze `MultiHopRouter` swap entrypoint used by the filler executor.
/// @dev Field order and types of {Hop}, {CexPriceData} and {SwapParams} mirror the Ryze
///      `IMultiHopRouter.SwapParams` / `IOracle.CexPriceData` exactly, so calldata built here ABI-encodes
///      identically to a direct call against the deployed router. Vendored so this repo has no dependency on
///      the Ryze contracts source tree. Ryze source of truth: ryze-contracts `src/amm/MultiHopRouter.sol`.
interface IRyzeRouter {
    /// @notice A single hop in a multi-hop swap path.
    struct Hop {
        address pool;
        address tokenIn;
        address tokenOut;
    }

    /// @notice Signed CEX price used by the Ryze oracle to verify the Pyth-blended price in the same tx.
    struct CexPriceData {
        address token;
        uint256 priceInWad;
        uint256 timestamp; // unix ms, must match the signed payload
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice Parameters for an exact-input multi-hop swap.
    struct SwapParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        Hop[] path;
        uint256 deadline;
        address recipient;
        bytes[] pythUpdateData;
        CexPriceData[] cexPriceData;
    }

    /// @notice Execute a multi-hop swap with exact input.
    /// @param params The swap parameters (carrying fresh Pyth/CEX price payloads).
    /// @return amountOut The actual output amount received.
    function swapExactIn(SwapParams calldata params) external payable returns (uint256 amountOut);
}
