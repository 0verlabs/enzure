// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IEnzureConsumer} from "enzure/IEnzureConsumer.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice The demo escrow for agent work, an Enzure EVM Consumer (example code).
///
/// A buyer funds a job in USDC and names the seller's payout address, the
/// sha256 of the seller's NEAR account id and the sha256 of the Claim the
/// seller must assert: a fixed template with this escrow's address, the chain
/// id, the job id and the brief. The seller posts that Assertion on the NEAR
/// oracle with an EVM Hook to this contract. When it settles, the Receiver
/// calls `assertionResolvedCallback`: TRUE pays the seller, FALSE refunds the
/// buyer. Only a result for the job's Claim by the job's seller counts, and
/// only the first. With no result by the deadline the buyer can reclaim.
contract Escrow is IEnzureConsumer {
    enum Status {
        None,
        Funded,
        Paid,
        Refunded,
        Reclaimed
    }

    struct Job {
        address buyer;
        /// The seller's payout address.
        address seller;
        uint256 amount;
        /// sha256 of the seller's NEAR account id (UTF-8), the Asserter the job expects.
        bytes32 sellerNear;
        /// sha256 of the Claim the seller must assert.
        bytes32 claimHash;
        /// Unix seconds; after it, with no result, the buyer can reclaim.
        uint64 deadline;
        Status status;
        /// The Assertion whose result paid or refunded the job.
        uint256 assertionId;
    }

    IERC20 public immutable token;
    /// The Enzure Receiver on this chain; the only caller of the callback.
    address public immutable receiver;
    /// The id the next job must take. A Claim names its job id, so the buyer
    /// reads this, writes the Claim, then creates the job with this id.
    uint256 public nextJobId = 1;

    mapping(uint256 jobId => Job) internal jobs;
    /// The job a Claim hash belongs to (0 if none). Each Claim belongs to one job.
    mapping(bytes32 claimHash => uint256 jobId) public jobOfClaim;

    event JobCreated(
        uint256 indexed jobId,
        address indexed buyer,
        address seller,
        uint256 amount,
        bytes32 sellerNear,
        bytes32 claimHash,
        uint64 deadline
    );
    event JobPaid(uint256 indexed jobId, uint256 indexed assertionId, address seller, uint256 amount);
    event JobRefunded(uint256 indexed jobId, uint256 indexed assertionId, address buyer, uint256 amount);
    event JobReclaimed(uint256 indexed jobId, address buyer, uint256 amount);
    /// A result from the Receiver that matched no open job, or not its seller.
    event ResultIgnored(uint256 indexed assertionId, bytes32 claimHash, bytes32 asserter);

    error WrongJobId(uint256 expected);
    error ClaimInUse();
    error InvalidJob();
    error NotReceiver();
    error NotFunded();
    error NotBuyer();
    error DeadlineNotPassed();
    error TransferFailed();

    constructor(address token_, address receiver_) {
        token = IERC20(token_);
        receiver = receiver_;
    }

    /// @notice Funds a job with `amount` of the token, taken from the caller
    /// (approve it first). `jobId` must be `nextJobId`.
    function createJob(
        uint256 jobId,
        uint256 amount,
        address seller,
        bytes32 sellerNear,
        bytes32 claimHash,
        uint64 deadline
    ) external {
        if (jobId != nextJobId) revert WrongJobId(nextJobId);
        if (jobOfClaim[claimHash] != 0) revert ClaimInUse();
        if (amount == 0 || seller == address(0) || deadline <= block.timestamp) revert InvalidJob();
        nextJobId = jobId + 1;
        jobs[jobId] = Job(msg.sender, seller, amount, sellerNear, claimHash, deadline, Status.Funded, 0);
        jobOfClaim[claimHash] = jobId;
        emit JobCreated(jobId, msg.sender, seller, amount, sellerNear, claimHash, deadline);
        _call(abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), amount)));
    }

    /// @inheritdoc IEnzureConsumer
    /// @dev Results from the Receiver that don't match an open job's Claim and
    /// seller are ignored (logged, no revert), so a retry does nothing either.
    function assertionResolvedCallback(uint256 assertionId, bool truthful, bytes32 claimHash, bytes32 asserter)
        external
    {
        if (msg.sender != receiver) revert NotReceiver();
        uint256 jobId = jobOfClaim[claimHash];
        Job storage job = jobs[jobId];
        if (job.status != Status.Funded || job.sellerNear != asserter) {
            emit ResultIgnored(assertionId, claimHash, asserter);
            return;
        }
        job.assertionId = assertionId;
        if (truthful) {
            job.status = Status.Paid;
            emit JobPaid(jobId, assertionId, job.seller, job.amount);
            _call(abi.encodeCall(IERC20.transfer, (job.seller, job.amount)));
        } else {
            job.status = Status.Refunded;
            emit JobRefunded(jobId, assertionId, job.buyer, job.amount);
            _call(abi.encodeCall(IERC20.transfer, (job.buyer, job.amount)));
        }
    }

    /// @notice Returns the funds of a job with no result to its buyer once the deadline has passed.
    function reclaim(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Funded) revert NotFunded();
        if (msg.sender != job.buyer) revert NotBuyer();
        if (block.timestamp <= job.deadline) revert DeadlineNotPassed();
        job.status = Status.Reclaimed;
        emit JobReclaimed(jobId, job.buyer, job.amount);
        _call(abi.encodeCall(IERC20.transfer, (job.buyer, job.amount)));
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }

    /// Calls the token and reverts unless it succeeded and returned true or nothing.
    function _call(bytes memory data) internal {
        (bool ok, bytes memory result) = address(token).call(data);
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
}
