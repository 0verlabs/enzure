// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Receiver} from "../src/Receiver.sol";
import {GasReportingConsumer, SwitchableConsumer} from "./TestConsumers.sol";

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

    function test_StoresTheOracleAddressFromDeployment() public view {
        assertEq(receiver.oracle(), 0x11B7c39799000F39b10b6B3c2320935366C34fCe);
    }

    function test_RejectsAZeroOracleAddress() public {
        vm.expectRevert(Receiver.ZeroOracle.selector);
        new Receiver(address(0));
    }

    function test_AnyoneCanReadTheRecordedOutcome() public {
        Receiver.Outcome memory before = receiver.outcomeOf(1);
        assertFalse(before.recorded);
        assertFalse(receiver.isDelivered(1, consumerAt));

        deliver(fixtureResult());

        Receiver.Outcome memory outcome = receiver.outcomeOf(1);
        assertTrue(outcome.recorded);
        assertTrue(outcome.truthful);
        assertEq(outcome.claimHash, 0x64a5dddb88128a31ba9a3c719b73d55160a125423dff298529c354abb204dd2a);
        assertEq(outcome.asserter, 0xd209d4ed1ac27c592d2d790dc3f9c7789e6f34debc22791573fa0f4597763d3c);
        assertEq(outcome.settledAt, 1794568779);
        assertTrue(receiver.isDelivered(1, consumerAt));
    }

    function test_EmitsTheRecordedOutcomeAndTheConsumerCall() public {
        vm.expectEmit(receiverAt);
        emit Receiver.OutcomeRecorded(
            1,
            consumerAt,
            true,
            0x64a5dddb88128a31ba9a3c719b73d55160a125423dff298529c354abb204dd2a,
            0xd209d4ed1ac27c592d2d790dc3f9c7789e6f34debc22791573fa0f4597763d3c,
            1794568779
        );
        vm.expectEmit(receiverAt);
        emit Receiver.ConsumerCalled(1, consumerAt, true);

        deliver(fixtureResult());
    }

    function test_RepeatedDeliveryDoesNothing() public {
        deliver(fixtureResult());

        vm.recordLogs();
        assertFalse(deliver(fixtureResult()));

        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(consumer.calls(), 1);
    }

    function test_RejectsAForgedSignature() public {
        uint256 forger = uint256(keccak256("forger"));
        Receiver.Result memory result = fixtureResult();
        bytes32 digest = vm.parseJsonBytes32(fixture, ".signed_result.digest");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(forger, digest);

        vm.expectRevert(Receiver.InvalidSignature.selector);
        receiver.deliver(result, v, r, s);
    }

    function test_RejectsAGarbledSignature() public {
        (uint8 v, bytes32 r, bytes32 s) = fixtureSignature();

        vm.expectRevert(Receiver.InvalidSignature.selector);
        receiver.deliver(fixtureResult(), v, r, bytes32(uint256(s) ^ 1));
        vm.expectRevert(Receiver.InvalidSignature.selector);
        receiver.deliver(fixtureResult(), v == 27 ? 28 : 27, r, s);
    }

    function test_RejectsTheWrongChainId() public {
        vm.chainId(1);

        vm.expectRevert(Receiver.InvalidSignature.selector);
        deliver(fixtureResult());
    }

    function test_RejectsTheWrongReceiver() public {
        address other = address(0x1000000000000000000000000000000000000003);
        deployCodeTo("Receiver.sol:Receiver", abi.encode(oracle), other);
        (uint8 v, bytes32 r, bytes32 s) = fixtureSignature();

        vm.expectRevert(Receiver.InvalidSignature.selector);
        Receiver(other).deliver(fixtureResult(), v, r, s);
    }

    function test_RejectsTheWrongConsumer() public {
        Receiver.Result memory result = fixtureResult();
        result.consumer = address(new SwitchableConsumer());

        vm.expectRevert(Receiver.InvalidSignature.selector);
        deliver(result);
    }

    function test_RejectsAChangedOutcome() public {
        Receiver.Result memory result = fixtureResult();
        result.outcome = false;

        vm.expectRevert(Receiver.InvalidSignature.selector);
        deliver(result);
    }

    function test_AFailingConsumerLeavesTheOutcomeRecorded() public {
        consumer.setFailing(true);

        vm.expectEmit(receiverAt);
        emit Receiver.ConsumerCalled(1, consumerAt, false);
        assertTrue(deliver(fixtureResult()));

        assertTrue(receiver.outcomeOf(1).recorded);
        assertTrue(receiver.isDelivered(1, consumerAt));
        assertEq(consumer.calls(), 0);
    }

    function test_AnyoneCanRetryTheConsumerCall() public {
        consumer.setFailing(true);
        deliver(fixtureResult());
        assertFalse(receiver.retryCallback(1, consumerAt));

        consumer.setFailing(false);
        vm.prank(makeAddr("anyone"));
        assertTrue(receiver.retryCallback(1, consumerAt));

        assertEq(consumer.calls(), 1);
        (address caller, uint256 assertionId, bool truthful,,) = consumer.last();
        assertEq(caller, receiverAt);
        assertEq(assertionId, 1);
        assertTrue(truthful);
    }

    function test_RetryNeedsARecordedOutcome() public {
        vm.expectRevert(abi.encodeWithSelector(Receiver.NotDelivered.selector, 1, consumerAt));
        receiver.retryCallback(1, consumerAt);
    }

    function test_TheConsumerGetsAFixedGasLimit() public {
        deployCodeTo("TestConsumers.sol:GasReportingConsumer", consumerAt);
        (uint8 v, bytes32 r, bytes32 s) = fixtureSignature();

        // Far more gas than the callback limit; the Consumer still gets only CALLBACK_GAS.
        receiver.deliver{gas: 5_000_000}(fixtureResult(), v, r, s);

        uint256 received = GasReportingConsumer(consumerAt).gasReceived();
        assertLe(received, 300_000);
        assertGt(received, 290_000);
    }

    function test_AConsumerThatRunsOutOfGasLeavesTheOutcomeRecorded() public {
        deployCodeTo("TestConsumers.sol:GasBurningConsumer", consumerAt);
        (uint8 v, bytes32 r, bytes32 s) = fixtureSignature();

        vm.expectEmit(receiverAt);
        emit Receiver.ConsumerCalled(1, consumerAt, false);
        receiver.deliver{gas: 5_000_000}(fixtureResult(), v, r, s);

        assertTrue(receiver.isDelivered(1, consumerAt));
    }

    function test_RejectsTooLittleGasForTheConsumer() public {
        (uint8 v, bytes32 r, bytes32 s) = fixtureSignature();

        vm.expectRevert(Receiver.InsufficientGas.selector);
        receiver.deliver{gas: 200_000}(fixtureResult(), v, r, s);

        assertFalse(receiver.isDelivered(1, consumerAt));
    }
}
