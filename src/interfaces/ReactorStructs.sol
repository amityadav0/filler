// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal vendored copy of UniswapX `ReactorStructs.sol`.
/// @dev Source: github.com/Uniswap/UniswapX (src/base/ReactorStructs.sol). Only the fields the executor
///      needs to decode `reactorCallback(ResolvedOrder[], bytes)` are reproduced. Field ORDER and TYPES must
///      match the reactor's ABI exactly or decoding of the callback payload will corrupt. UniswapX types the
///      token fields as solmate `ERC20`; that is ABI-identical to the OZ `IERC20` used here (both a 20-byte
///      address in a 32-byte word), so decoding is unaffected.

/// @notice Standard order information shared across all reactor order types.
struct OrderInfo {
    address reactor;
    address swapper;
    uint256 nonce;
    uint256 deadline;
    address additionalValidationContract;
    bytes additionalValidationData;
}

/// @notice The token and amount pulled from the swapper as swap input.
struct InputToken {
    IERC20 token;
    uint256 amount;
    uint256 maxAmount;
}

/// @notice A resolved output the executor must make available to the reactor for the recipient.
struct OutputToken {
    address token;
    uint256 amount;
    address recipient;
}

/// @notice An order resolved to concrete input/output amounts, passed to `reactorCallback`.
struct ResolvedOrder {
    OrderInfo info;
    InputToken input;
    OutputToken[] outputs;
    bytes sig;
    bytes32 hash;
}

/// @notice An encoded, signed order handed to the reactor's `execute*` entrypoints.
struct SignedOrder {
    bytes order;
    bytes sig;
}
