// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IEnzureConsumer} from "enzure/IEnzureConsumer.sol";

/// @notice An example EVM Consumer: records each Assertion outcome the Enzure
/// Receiver delivers to it. It accepts calls only from its Receiver and keeps
/// the first result for each Assertion, ignoring repeats.
contract ExampleConsumer is IEnzureConsumer {
    struct Resolution {
        bool known;
        bool truthful;
        bytes32 claimHash;
        bytes32 asserter;
    }

    address public immutable receiver;
    mapping(uint256 assertionId => Resolution) public results;
    uint256 public resolvedCount;

    event Resolved(uint256 indexed assertionId, bool truthful, bytes32 claimHash, bytes32 asserter);

    error NotReceiver();

    constructor(address receiver_) {
        receiver = receiver_;
    }

    function assertionResolvedCallback(uint256 assertionId, bool truthful, bytes32 claimHash, bytes32 asserter)
        external
    {
        if (msg.sender != receiver) revert NotReceiver();
        if (results[assertionId].known) return;
        results[assertionId] = Resolution(true, truthful, claimHash, asserter);
        resolvedCount += 1;
        emit Resolved(assertionId, truthful, claimHash, asserter);
    }
}
