// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IEnzureConsumer} from "../src/IEnzureConsumer.sol";

/// @notice Test Consumer that records every callback and can be switched to fail.
contract SwitchableConsumer is IEnzureConsumer {
    struct Call {
        address caller;
        uint256 assertionId;
        bool truthful;
        bytes32 claimHash;
        bytes32 asserter;
    }

    bool public failing;
    uint256 public calls;
    Call public last;

    function setFailing(bool failing_) external {
        failing = failing_;
    }

    function assertionResolvedCallback(uint256 assertionId, bool truthful, bytes32 claimHash, bytes32 asserter)
        external
    {
        require(!failing, "consumer is failing");
        calls += 1;
        last = Call(msg.sender, assertionId, truthful, claimHash, asserter);
    }
}

/// @notice Test Consumer that burns gas until the call runs out.
contract GasBurningConsumer is IEnzureConsumer {
    uint256 public calls;

    function assertionResolvedCallback(uint256, bool, bytes32, bytes32) external {
        calls += 1;
        while (true) {}
    }
}
