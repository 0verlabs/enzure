// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Receiver} from "enzure/Receiver.sol";
import {Escrow} from "../src/Escrow.sol";
import {TestUSDC} from "../src/TestUSDC.sol";

/// @notice Delivers the real testnet signed result (fixtures/chain-signatures)
/// through the real Receiver to an escrow whose job expects that Claim and Asserter.
contract EscrowReceiverTest is Test {
    string internal fixture;
    address internal receiverAt;
    address internal escrowAt;
    TestUSDC internal usdc;
    Escrow internal escrow;

    address internal buyer = makeAddr("buyer");
    address internal seller = makeAddr("seller");
    uint256 internal constant AMOUNT = 10e6;

    function setUp() public {
        fixture = vm.readFile(string.concat(vm.projectRoot(), "/../../fixtures/chain-signatures/signed-result.json"));
        receiverAt = vm.parseJsonAddress(fixture, ".signed_result.receiver");
        escrowAt = vm.parseJsonAddress(fixture, ".signed_result.consumer");
        vm.chainId(vm.parseJsonUint(fixture, ".signed_result.chain_id"));
        deployCodeTo("Receiver.sol:Receiver", abi.encode(vm.parseJsonAddress(fixture, ".address")), receiverAt);
        usdc = new TestUSDC();
        deployCodeTo("Escrow.sol:Escrow", abi.encode(address(usdc), receiverAt), escrowAt);
        escrow = Escrow(escrowAt);

        usdc.mint(buyer, AMOUNT);
        vm.startPrank(buyer);
        usdc.approve(escrowAt, AMOUNT);
        escrow.createJob(
            1,
            AMOUNT,
            seller,
            vm.parseJsonBytes32(fixture, ".signed_result.asserter_hash"),
            vm.parseJsonBytes32(fixture, ".signed_result.claim_hash"),
            uint64(block.timestamp + 1 days)
        );
        vm.stopPrank();
    }

    function deliver() internal returns (bool) {
        Receiver.Result memory result = Receiver.Result({
            assertionId: vm.parseJsonUint(fixture, ".signed_result.assertion_id"),
            consumer: escrowAt,
            outcome: vm.parseJsonBool(fixture, ".signed_result.outcome"),
            claimHash: vm.parseJsonBytes32(fixture, ".signed_result.claim_hash"),
            asserter: vm.parseJsonBytes32(fixture, ".signed_result.asserter_hash"),
            settledAt: vm.parseJsonUint(fixture, ".signed_result.settled_at")
        });
        return Receiver(receiverAt)
            .deliver(
                result,
                uint8(vm.parseJsonUint(fixture, ".signed_result.v")),
                vm.parseJsonBytes32(fixture, ".signed_result.r"),
                vm.parseJsonBytes32(fixture, ".signed_result.s")
            );
    }

    function test_ASignedTrueResultDeliveredByTheRelayerPaysTheSeller() public {
        vm.expectEmit(receiverAt);
        emit Receiver.ConsumerCalled(1, escrowAt, true);

        assertTrue(deliver());

        assertEq(usdc.balanceOf(seller), AMOUNT);
        assertEq(uint8(escrow.getJob(1).status), uint8(Escrow.Status.Paid));
        assertEq(escrow.getJob(1).assertionId, 1);
    }

    function test_ARepeatedDeliveryOrRetryPaysOnce() public {
        deliver();

        assertFalse(deliver());
        Receiver(receiverAt).retryCallback(1, escrowAt);

        assertEq(usdc.balanceOf(seller), AMOUNT);
        assertEq(usdc.balanceOf(escrowAt), 0);
    }
}
