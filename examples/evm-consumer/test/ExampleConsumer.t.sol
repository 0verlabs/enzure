// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Receiver} from "enzure/Receiver.sol";
import {ExampleConsumer} from "../src/ExampleConsumer.sol";

/// @notice Delivers the real testnet signed result through a Receiver to the example Consumer.
contract ExampleConsumerTest is Test {
    string internal fixture;
    address internal receiverAt;
    address internal consumerAt;
    ExampleConsumer internal consumer;

    function setUp() public {
        fixture = vm.readFile(string.concat(vm.projectRoot(), "/../../fixtures/chain-signatures/signed-result.json"));
        receiverAt = vm.parseJsonAddress(fixture, ".signed_result.receiver");
        consumerAt = vm.parseJsonAddress(fixture, ".signed_result.consumer");
        vm.chainId(vm.parseJsonUint(fixture, ".signed_result.chain_id"));
        deployCodeTo("Receiver.sol:Receiver", abi.encode(vm.parseJsonAddress(fixture, ".address")), receiverAt);
        deployCodeTo("ExampleConsumer.sol:ExampleConsumer", abi.encode(receiverAt), consumerAt);
        consumer = ExampleConsumer(consumerAt);
    }

    function deliver() internal {
        Receiver.Result memory result = Receiver.Result({
            assertionId: vm.parseJsonUint(fixture, ".signed_result.assertion_id"),
            consumer: consumerAt,
            outcome: vm.parseJsonBool(fixture, ".signed_result.outcome"),
            claimHash: vm.parseJsonBytes32(fixture, ".signed_result.claim_hash"),
            asserter: vm.parseJsonBytes32(fixture, ".signed_result.asserter_hash"),
            settledAt: vm.parseJsonUint(fixture, ".signed_result.settled_at")
        });
        Receiver(receiverAt)
            .deliver(
                result,
                uint8(vm.parseJsonUint(fixture, ".signed_result.v")),
                vm.parseJsonBytes32(fixture, ".signed_result.r"),
                vm.parseJsonBytes32(fixture, ".signed_result.s")
            );
    }

    function test_RecordsTheOutcomeDeliveredByTheReceiver() public {
        deliver();

        (bool known, bool truthful, bytes32 claimHash, bytes32 asserter) = consumer.results(1);
        assertTrue(known);
        assertTrue(truthful);
        assertEq(claimHash, 0x64a5dddb88128a31ba9a3c719b73d55160a125423dff298529c354abb204dd2a);
        assertEq(asserter, 0xd209d4ed1ac27c592d2d790dc3f9c7789e6f34debc22791573fa0f4597763d3c);
        assertEq(consumer.resolvedCount(), 1);
    }

    function test_IgnoresARetriedCallback() public {
        deliver();

        Receiver(receiverAt).retryCallback(1, consumerAt);

        assertEq(consumer.resolvedCount(), 1);
    }

    function test_RejectsCallsFromAnyoneButTheReceiver() public {
        vm.expectRevert(ExampleConsumer.NotReceiver.selector);
        consumer.assertionResolvedCallback(1, false, bytes32(0), bytes32(0));
    }
}
