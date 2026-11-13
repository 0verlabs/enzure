// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../src/Escrow.sol";
import {TestUSDC} from "../src/TestUSDC.sol";

/// @notice The escrow as the buyer, the seller and the Receiver see it. The
/// Receiver is played by an address here; EscrowReceiverTest delivers a real
/// signed result through the real Receiver.
contract EscrowTest is Test {
    TestUSDC internal usdc;
    Escrow internal escrow;

    address internal receiver = makeAddr("receiver");
    address internal buyer = makeAddr("buyer");
    address internal seller = makeAddr("seller");

    uint256 internal constant AMOUNT = 25e6; // 25 USDC
    bytes32 internal sellerNear = sha256(bytes("seller.testnet"));
    bytes32 internal claimHash = sha256(bytes("The deliverable in the Asserter's Evidence satisfies the brief."));
    uint64 internal deadline;

    function setUp() public {
        usdc = new TestUSDC();
        escrow = new Escrow(address(usdc), receiver);
        deadline = uint64(block.timestamp + 1 days);
        usdc.mint(buyer, 100e6);
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function createJob() internal returns (uint256 jobId) {
        jobId = escrow.nextJobId();
        vm.prank(buyer);
        escrow.createJob(jobId, AMOUNT, seller, sellerNear, claimHash, deadline);
    }

    function resolve(uint256 assertionId, bool truthful, bytes32 claim, bytes32 asserter) internal {
        vm.prank(receiver);
        escrow.assertionResolvedCallback(assertionId, truthful, claim, asserter);
    }

    function test_CreatingAJobTakesTheAmountFromTheBuyerAndRecordsTheTerms() public {
        uint256 jobId = createJob();

        Escrow.Job memory job = escrow.getJob(jobId);
        assertEq(jobId, 1);
        assertEq(escrow.nextJobId(), 2);
        assertEq(job.buyer, buyer);
        assertEq(job.seller, seller);
        assertEq(job.amount, AMOUNT);
        assertEq(job.sellerNear, sellerNear);
        assertEq(job.claimHash, claimHash);
        assertEq(job.deadline, deadline);
        assertEq(uint8(job.status), uint8(Escrow.Status.Funded));
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
        assertEq(usdc.balanceOf(buyer), 100e6 - AMOUNT);
        assertEq(escrow.jobOfClaim(claimHash), jobId);
    }

    function test_AJobIdIsTakenInOrder() public {
        createJob();
        bytes32 anotherClaim = sha256(bytes("another claim"));

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Escrow.WrongJobId.selector, 2));
        escrow.createJob(1, AMOUNT, seller, sellerNear, anotherClaim, deadline);
    }

    function test_EachClaimBelongsToOneJob() public {
        createJob();

        vm.prank(buyer);
        vm.expectRevert(Escrow.ClaimInUse.selector);
        escrow.createJob(2, AMOUNT, seller, sellerNear, claimHash, deadline);
    }

    function test_RejectsAJobWithoutAmountSellerOrFutureDeadline() public {
        vm.startPrank(buyer);
        vm.expectRevert(Escrow.InvalidJob.selector);
        escrow.createJob(1, 0, seller, sellerNear, claimHash, deadline);
        vm.expectRevert(Escrow.InvalidJob.selector);
        escrow.createJob(1, AMOUNT, address(0), sellerNear, claimHash, deadline);
        vm.expectRevert(Escrow.InvalidJob.selector);
        escrow.createJob(1, AMOUNT, seller, sellerNear, claimHash, uint64(block.timestamp));
        vm.stopPrank();
    }

    function test_ATrueResultForTheJobPaysTheSeller() public {
        uint256 jobId = createJob();

        resolve(7, true, claimHash, sellerNear);

        assertEq(usdc.balanceOf(seller), AMOUNT);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(Escrow.Status.Paid));
        assertEq(escrow.getJob(jobId).assertionId, 7);
    }

    function test_AFalseResultForTheJobRefundsTheBuyer() public {
        uint256 jobId = createJob();

        resolve(7, false, claimHash, sellerNear);

        assertEq(usdc.balanceOf(buyer), 100e6);
        assertEq(usdc.balanceOf(seller), 0);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(Escrow.Status.Refunded));
    }

    function test_IgnoresAResultForAnotherClaim() public {
        uint256 jobId = createJob();

        resolve(7, true, sha256(bytes("Some other true statement.")), sellerNear);

        assertEq(usdc.balanceOf(seller), 0);
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(Escrow.Status.Funded));
    }

    function test_IgnoresAResultFromAnotherAsserter() public {
        uint256 jobId = createJob();

        resolve(7, true, claimHash, sha256(bytes("someone-else.testnet")));
        resolve(8, false, claimHash, sha256(bytes("someone-else.testnet")));

        assertEq(usdc.balanceOf(seller), 0);
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(Escrow.Status.Funded));
    }

    function test_RejectsResultsFromAnyoneButTheReceiver() public {
        uint256 jobId = createJob();

        vm.prank(seller);
        vm.expectRevert(Escrow.NotReceiver.selector);
        escrow.assertionResolvedCallback(7, true, claimHash, sellerNear);

        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(Escrow.Status.Funded));
    }

    function test_TheFirstMatchingResultWinsAndLaterOnesAreIgnored() public {
        uint256 jobId = createJob();
        usdc.mint(address(escrow), 1e6); // a stray balance a second payout could take

        resolve(7, true, claimHash, sellerNear);
        resolve(7, true, claimHash, sellerNear); // a retried callback
        resolve(9, false, claimHash, sellerNear); // a later Assertion of the same Claim

        assertEq(usdc.balanceOf(seller), AMOUNT);
        assertEq(usdc.balanceOf(buyer), 100e6 - AMOUNT);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(Escrow.Status.Paid));
        assertEq(escrow.getJob(jobId).assertionId, 7);
    }

    function test_TheBuyerReclaimsAfterTheDeadlineWithNoResult() public {
        uint256 jobId = createJob();
        vm.warp(deadline + 1);

        vm.prank(buyer);
        escrow.reclaim(jobId);

        assertEq(usdc.balanceOf(buyer), 100e6);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(Escrow.Status.Reclaimed));

        // A result that arrives afterwards changes nothing.
        resolve(7, true, claimHash, sellerNear);
        assertEq(usdc.balanceOf(seller), 0);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(Escrow.Status.Reclaimed));
    }

    function test_TheBuyerCannotReclaimBeforeTheDeadline() public {
        uint256 jobId = createJob();
        vm.warp(deadline);

        vm.prank(buyer);
        vm.expectRevert(Escrow.DeadlineNotPassed.selector);
        escrow.reclaim(jobId);
    }

    function test_OnlyTheBuyerCanReclaim() public {
        uint256 jobId = createJob();
        vm.warp(deadline + 1);

        vm.prank(seller);
        vm.expectRevert(Escrow.NotBuyer.selector);
        escrow.reclaim(jobId);
    }

    function test_ASettledJobCannotBeReclaimed() public {
        uint256 jobId = createJob();
        resolve(7, true, claimHash, sellerNear);
        vm.warp(deadline + 1);

        vm.prank(buyer);
        vm.expectRevert(Escrow.NotFunded.selector);
        escrow.reclaim(jobId);
    }
}
