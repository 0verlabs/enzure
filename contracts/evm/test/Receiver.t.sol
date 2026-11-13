// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Receiver} from "../src/Receiver.sol";
import {SwitchableConsumer} from "./TestConsumers.sol";

/// @notice Drives the Receiver with the real Chain Signatures signing from NEAR
/// testnet in fixtures/chain-signatures/signed-result.json. The fixture's
/// Receiver and Consumer addresses are placeholders, so the tests place the
/// contracts there.
contract ReceiverTest is Test {
    string internal fixture;
    address internal oracle;
    address internal receiverAt;
    address internal consumerAt;
    uint256 internal chainId;

    Receiver internal receiver;
    SwitchableConsumer internal consumer;

    function setUp() public {
        fixture = vm.readFile(string.concat(vm.projectRoot(), "/../../fixtures/chain-signatures/signed-result.json"));
        oracle = vm.parseJsonAddress(fixture, ".address");
        receiverAt = vm.parseJsonAddress(fixture, ".signed_result.receiver");
        consumerAt = vm.parseJsonAddress(fixture, ".signed_result.consumer");
        chainId = vm.parseJsonUint(fixture, ".signed_result.chain_id");

        vm.chainId(chainId);
        deployCodeTo("Receiver.sol:Receiver", abi.encode(oracle), receiverAt);
        deployCodeTo("TestConsumers.sol:SwitchableConsumer", consumerAt);
        receiver = Receiver(receiverAt);
        consumer = SwitchableConsumer(consumerAt);
    }

    function fixtureResult() internal view returns (Receiver.Result memory) {
        return Receiver.Result({
            assertionId: vm.parseJsonUint(fixture, ".signed_result.assertion_id"),
            consumer: consumerAt,
            outcome: vm.parseJsonBool(fixture, ".signed_result.outcome"),
            claimHash: vm.parseJsonBytes32(fixture, ".signed_result.claim_hash"),
            asserter: vm.parseJsonBytes32(fixture, ".signed_result.asserter_hash"),
            settledAt: vm.parseJsonUint(fixture, ".signed_result.settled_at")
        });
    }

    function fixtureSignature() internal view returns (uint8 v, bytes32 r, bytes32 s) {
        v = uint8(vm.parseJsonUint(fixture, ".signed_result.v"));
        r = vm.parseJsonBytes32(fixture, ".signed_result.r");
        s = vm.parseJsonBytes32(fixture, ".signed_result.s");
    }

    function deliver(Receiver.Result memory result) internal returns (bool) {
        (uint8 v, bytes32 r, bytes32 s) = fixtureSignature();
        return receiver.deliver(result, v, r, s);
    }

    function test_TestnetSignedResultReachesTheConsumer() public {
        Receiver.Result memory result = fixtureResult();

        assertTrue(deliver(result));

        assertEq(consumer.calls(), 1);
        (address caller, uint256 assertionId, bool truthful, bytes32 claimHash, bytes32 asserter) = consumer.last();
        assertEq(caller, receiverAt);
        assertEq(assertionId, 1);
        assertTrue(truthful);
        assertEq(claimHash, 0x64a5dddb88128a31ba9a3c719b73d55160a125423dff298529c354abb204dd2a);
        assertEq(asserter, 0xd209d4ed1ac27c592d2d790dc3f9c7789e6f34debc22791573fa0f4597763d3c);
    }
}
