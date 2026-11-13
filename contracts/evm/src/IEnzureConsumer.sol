// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice What an EVM Consumer implements to receive settled Assertions from
/// the Receiver. The Receiver may call it again for the same Assertion (anyone
/// can retry a recorded outcome), so a Consumer must ignore repeats and check
/// that the caller is the Receiver.
interface IEnzureConsumer {
    /// @param assertionId The Assertion's id on the NEAR oracle.
    /// @param truthful The settled outcome: true if the Claim was upheld.
    /// @param claimHash sha256 of the Claim.
    /// @param asserter sha256 of the Asserter's NEAR account id (UTF-8).
    function assertionResolvedCallback(uint256 assertionId, bool truthful, bytes32 claimHash, bytes32 asserter)
        external;
}
