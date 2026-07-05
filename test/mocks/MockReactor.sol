// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IReactorCallback} from "../../src/interfaces/IReactorCallback.sol";
import {ResolvedOrder, SignedOrder, OrderInfo, InputToken, OutputToken} from "../../src/interfaces/ReactorStructs.sol";

/// @notice Faithful stand-in for UniswapX `BaseReactor.executeWithCallback` used in filler unit tests.
/// @dev Mirrors the source-verified settlement semantics (Uniswap/UniswapX `main`):
///      1. `_prepare`: pull the swapper's input tokens to the fill contract (`msg.sender`) — here a plain
///         `transferFrom` in place of the Permit2 pull; the swapper must have approved this reactor.
///      2. call `reactorCallback` on the fill contract.
///      3. `_fill`: settle each output — ERC20 via `transferFrom(fillContract, recipient)` (fill contract must
///         have approved the reactor); native (`token == address(0)`) via `.call{value}` from the reactor's own
///         balance (fill contract must have sent that ETH to the reactor during the callback).
///      4. refund any leftover native balance to the fill contract.
///      The test encodes `signedOrder.order` as `abi.encode(TestOrder)`.
contract MockReactor {
    address internal constant NATIVE = address(0);

    /// @notice Minimal order shape for tests: one input, N outputs, a swapper.
    struct TestOrder {
        address swapper;
        uint256 nonce;
        address inputToken;
        uint256 inputAmount;
        OutputToken[] outputs;
    }

    error NativeTransferFailed();

    /// @dev BaseReactor is payable and holds native ETH between the callback and `_fill`; the fill contract
    ///      funds it with ETH for native outputs during `reactorCallback`.
    receive() external payable {}

    function executeWithCallback(SignedOrder calldata signedOrder, bytes calldata callbackData) external payable {
        TestOrder memory order = abi.decode(signedOrder.order, (TestOrder));

        ResolvedOrder[] memory resolved = new ResolvedOrder[](1);
        resolved[0] = ResolvedOrder({
            info: OrderInfo({
                reactor: address(this),
                swapper: order.swapper,
                nonce: order.nonce,
                deadline: block.timestamp,
                additionalValidationContract: address(0),
                additionalValidationData: ""
            }),
            input: InputToken({
                token: IERC20(order.inputToken), amount: order.inputAmount, maxAmount: order.inputAmount
            }),
            outputs: order.outputs,
            sig: signedOrder.sig,
            hash: keccak256(signedOrder.order)
        });

        // _prepare: pull swapper input to the fill contract (msg.sender).
        IERC20(order.inputToken).transferFrom(order.swapper, msg.sender, order.inputAmount);

        // callback: fill contract sources outputs.
        IReactorCallback(msg.sender).reactorCallback(resolved, callbackData);

        // _fill: settle outputs to recipients.
        OutputToken[] memory outputs = resolved[0].outputs;
        for (uint256 j = 0; j < outputs.length; j++) {
            OutputToken memory output = outputs[j];
            if (output.token == NATIVE) {
                (bool ok,) = output.recipient.call{value: output.amount}("");
                if (!ok) revert NativeTransferFailed();
            } else {
                IERC20(output.token).transferFrom(msg.sender, output.recipient, output.amount);
            }
        }

        // refund leftover native to the fill contract.
        if (address(this).balance > 0) {
            (bool ok,) = msg.sender.call{value: address(this).balance}("");
            if (!ok) revert NativeTransferFailed();
        }
    }
}
