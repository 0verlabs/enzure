// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IEnzureConsumer} from "./IEnzureConsumer.sol";

/// @title Enzure Receiver
/// @notice The one contract on an EVM chain that accepts results signed by the
/// Enzure oracle on NEAR (ADR 0002). It checks that a result was signed by the
/// oracle's derived EVM address for this chain and this Receiver, records the
/// outcome once per Assertion and Consumer, and calls the Consumer.
///
/// The oracle signs `keccak256(abi.encode(VERSION, chainId, receiver, consumer,
/// assertionId, outcome, claimHash, asserter, settledAt))` with no EIP-191
/// prefix; this contract rebuilds that message with its own chain id and
/// address, so a result signed for another chain or Receiver is rejected.
contract Receiver {
    /// @notice The result message's version word, `keccak256("enzure.hook.v1")`.
    bytes32 public constant VERSION = keccak256("enzure.hook.v1");
    /// @notice Gas given to each Consumer callback, the same on every call.
    uint256 public constant CALLBACK_GAS = 300_000;
    /// @dev Gas this contract needs after the callback returns: event and bookkeeping.
    uint256 private constant GAS_AFTER_CALLBACK = 10_000;

    /// @notice A signed result's fields, apart from the chain id and Receiver,
    /// which come from this contract.
    struct Result {
        uint256 assertionId;
        address consumer;
        bool outcome;
        bytes32 claimHash;
        /// sha256 of the Asserter's NEAR account id.
        bytes32 asserter;
        /// Settlement time on NEAR, Unix seconds.
        uint256 settledAt;
    }

    /// @notice A recorded Assertion outcome, readable by anyone.
    struct Outcome {
        bool recorded;
        bool truthful;
        bytes32 claimHash;
        bytes32 asserter;
        uint256 settledAt;
    }

    /// @notice The oracle's derived EVM address, fixed at deployment.
    address public immutable oracle;

    mapping(uint256 assertionId => Outcome) private _outcomes;
    mapping(uint256 assertionId => mapping(address consumer => bool)) private _delivered;

    event OutcomeRecorded(
        uint256 indexed assertionId,
        address indexed consumer,
        bool truthful,
        bytes32 claimHash,
        bytes32 asserter,
        uint256 settledAt
    );
    /// @notice Emitted after each Consumer call; `success` is false if it reverted or ran out of gas.
    event ConsumerCalled(uint256 indexed assertionId, address indexed consumer, bool success);

    error ZeroOracle();
    error InvalidSignature();
    error NotDelivered(uint256 assertionId, address consumer);
    error InsufficientGas();

    constructor(address oracle_) {
        if (oracle_ == address(0)) revert ZeroOracle();
        oracle = oracle_;
    }

    /// @notice Delivers a result signed by the oracle: records the outcome for
    /// the Assertion and Consumer and calls the Consumer with `CALLBACK_GAS`.
    /// Anyone can call it. A Consumer that reverts doesn't undo the record; call
    /// `retryCallback` to run it again.
    /// @return recorded True if this call recorded the outcome; false if it was
    /// already recorded, in which case nothing happens.
    function deliver(Result calldata result, uint8 v, bytes32 r, bytes32 s) external returns (bool recorded) {
        bytes32 digest = keccak256(
            abi.encode(
                VERSION,
                block.chainid,
                address(this),
                result.consumer,
                result.assertionId,
                result.outcome,
                result.claimHash,
                result.asserter,
                result.settledAt
            )
        );
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != oracle) revert InvalidSignature();

        if (_delivered[result.assertionId][result.consumer]) return false;
        _delivered[result.assertionId][result.consumer] = true;
        Outcome storage outcome = _outcomes[result.assertionId];
        if (!outcome.recorded) {
            _outcomes[result.assertionId] =
                Outcome(true, result.outcome, result.claimHash, result.asserter, result.settledAt);
        }
        emit OutcomeRecorded(
            result.assertionId, result.consumer, result.outcome, result.claimHash, result.asserter, result.settledAt
        );
        _callConsumer(result.assertionId, result.consumer);
        return true;
    }

    /// @notice Runs the Consumer call again for a recorded outcome. Anyone can call it.
    /// @return success Whether the Consumer call succeeded.
    function retryCallback(uint256 assertionId, address consumer) external returns (bool success) {
        if (!_delivered[assertionId][consumer]) revert NotDelivered(assertionId, consumer);
        return _callConsumer(assertionId, consumer);
    }

    /// @notice The recorded outcome of an Assertion; `recorded` is false if none was delivered yet.
    function outcomeOf(uint256 assertionId) external view returns (Outcome memory) {
        return _outcomes[assertionId];
    }

    /// @notice Whether the outcome of `assertionId` was delivered for `consumer`.
    function isDelivered(uint256 assertionId, address consumer) external view returns (bool) {
        return _delivered[assertionId][consumer];
    }

    function _callConsumer(uint256 assertionId, address consumer) private returns (bool success) {
        Outcome storage outcome = _outcomes[assertionId];
        bytes memory data = abi.encodeCall(
            IEnzureConsumer.assertionResolvedCallback,
            (assertionId, outcome.truthful, outcome.claimHash, outcome.asserter)
        );
        // A call forwards at most 63/64 of the gas left, so a caller can't make
        // the Consumer fail by sending too little gas.
        if (gasleft() < (CALLBACK_GAS * 64) / 63 + GAS_AFTER_CALLBACK) revert InsufficientGas();
        uint256 callbackGas = CALLBACK_GAS;
        // No return data is copied, so a Consumer can't make this call expensive.
        assembly ("memory-safe") {
            success := call(callbackGas, consumer, 0, add(data, 0x20), mload(data), 0, 0)
        }
        emit ConsumerCalled(assertionId, consumer, success);
    }
}
