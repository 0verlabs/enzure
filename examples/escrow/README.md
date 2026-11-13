# Escrow demo

Example code, not part of Enzure (ADR 0005). A buyer funds a job on an escrow on Base Sepolia in test USDC. A seller agent does the work with NEAR AI and asserts on the NEAR oracle that it satisfies the brief, with an EVM Hook to the escrow. The buyer disputes, the Keeper's Resolver gets an AI Verdict, the Assertion settles, the Hook is signed through Chain Signatures and relayed to the Receiver, and the escrow pays the seller (TRUE) or refunds the buyer (FALSE).

| Path | What it is |
| --- | --- |
| `src/Escrow.sol` | The escrow, an `IEnzureConsumer`. |
| `src/TestUSDC.sol` | The fallback token: a 6-decimal ERC-20 anyone can mint. |
| `test/` | Foundry tests: `Escrow.t.sol` (pay, refund, ignored results, repeats, reclaim, job creation) and `EscrowReceiver.t.sol` (the real testnet signed result through the real Receiver pays the seller once). |
| `script/DeployEscrow.s.sol` | Deploys the escrow for a Receiver, and TestUSDC if no token is given. |
| `agent/claim.mts` | The Claim template, shared by the buyer and the seller, with `node:test` tests. |
| `agent/buyer.mts` | The buyer: `create-job`, `dispute`, `reclaim`, `job`. |
| `agent/seller.mts` | The seller agent. |
| `demo.sh` | The whole flow in one script, printing every transaction link. |

## The escrow

`createJob(jobId, amount, seller, sellerNear, claimHash, deadline)` takes `amount` of the token from the buyer (approve first). `seller` is the payout address on Base, `sellerNear` the sha256 of the seller's NEAR account id, `claimHash` the sha256 of the Claim the seller must assert, `deadline` Unix seconds. `jobId` must equal `nextJobId()`, because the Claim names its job id: the buyer reads the id, writes the Claim, then creates the job. Each Claim hash belongs to one job.

When the Receiver calls `assertionResolvedCallback(assertionId, truthful, claimHash, asserter)`, the escrow looks up the job by Claim hash. If the job is still funded and `asserter` equals the job's `sellerNear`, TRUE pays the seller and FALSE refunds the buyer. Anything else is ignored with a `ResultIgnored` event and no revert: another Claim, another Asserter, a job already paid, refunded or reclaimed, or a retried callback. Calls from anyone but the Receiver revert `NotReceiver`. A result that arrives after the deadline still counts if the buyer hasn't reclaimed yet.

`reclaim(jobId)`: the buyer gets the funds back once `block.timestamp > deadline` and no result has arrived.

## The Claim

The buyer fills in a fixed template (`agent/claim.mts`):

```text
Enzure escrow job 3 on EVM chain 84532, escrow contract 0x….
Claim: the deliverable in the Asserter's Evidence satisfies the brief below.

Brief:
<the full brief>
```

The escrow address, chain id and job id stop a seller from collecting a job with an unrelated true statement; the brief is what the AI judges the Evidence against. The seller agent downloads the Claim by the job's hash, checks the hash and that the text is exactly this template for this escrow, chain and job, and asserts that same Claim.

## Token: Circle's test USDC, with TestUSDC as the fallback

The demo uses Circle's test USDC on Base Sepolia, `0x036CbD53842c5426634e7929541eC2318f3dCF7e` ([Circle docs](https://developers.circle.com/gateway/quickstarts/eco-gasless-deposits)), which the [Circle faucet](https://faucet.circle.com) hands out without an account (20 USDC per address every 2 hours as of October 2026). That is the default of `demo.sh` and the token to show judges. If the faucet is unavailable, `TEST_USDC=1 ./examples/escrow/demo.sh` deploys `TestUSDC` (6 decimals, open `mint`) and mints 1000 tUSDC to the buyer. The escrow works the same with either: it checks the token's return value and accepts tokens that return nothing.

## Run it

Install first: `cd typescript && vp install && vp run --filter @enzure/keeper build`. The scripts are plain Node (`node file.mts`) and load `@enzure/core` from source, viem from core and near-kit from the Keeper.

```bash
(cd examples/escrow && forge test)               # 16 Foundry tests
node --test examples/escrow/agent/*.test.mts     # Claim template tests
./examples/escrow/demo.sh paid                   # honest seller: AI rules TRUE, escrow pays
./examples/escrow/demo.sh refunded               # off-brief seller: AI rules FALSE, escrow refunds
```

`demo.sh` reads from the environment or the root `.env`:

- `NEAR_ACCOUNT_ID`, `NEAR_PRIVATE_KEY`: the buyer on NEAR testnet. It disputes, funds the seller's new account `seller-<timestamp>.<NEAR_ACCOUNT_ID>` (1.5 NEAR) and signs the Keeper's calls. About 3 NEAR per run; the winner's 1.5 NEAR comes back through `withdraw`.
- `NEARAI_API_KEY`: the seller agent and the Resolver.
- `EVM_PRIVATE_KEY`: the buyer on Base Sepolia. It deploys the Receiver and escrow, funds the job and pays the Relayer's gas, so it needs Base Sepolia ETH and test USDC (`AMOUNT`, default 1).

Optional: `ORACLE_ACCOUNT_ID` (default `oracle-1794575543.enzure-council-a-1794575224.testnet`, the DAO-governed oracle), `RECEIVER_ADDRESS` and `ESCROW_ADDRESS` to reuse deployments (otherwise `scripts/deploy-receiver.sh` and `DeployEscrow.s.sol` run), `USDC_ADDRESS`, `TEST_USDC=1`, `SELLER_NEAR_ACCOUNT_ID` + `SELLER_NEAR_PRIVATE_KEY`, `SELLER_EVM_ADDRESS` (default: a fresh address nobody holds the key to), `BRIEF`, `BUYER_EVIDENCE`, `LIVENESS_SECS` (60), `EVM_RPC_URL`, `STORAGE_URL`, `NO_KEEPER=1` (wait for a running Keeper instead of starting one), `EVM_EXPLORER_TX`.

The AI decides the outcome. `paid` uses an honest seller and `refunded` passes `--off-brief`, which makes the seller agent write a rhyme about cats instead of the brief; the script prints what the oracle ruled and what the escrow did.

The steps one by one, with `ESCROW_ADDRESS`, `EVM_RPC_URL` and the keys in the environment:

```bash
node examples/escrow/agent/buyer.mts create-job --brief "…" --amount 1 --seller 0x… --seller-near seller.testnet
SELLER_NEAR_ACCOUNT_ID=seller.testnet SELLER_NEAR_PRIVATE_KEY=… ORACLE_ACCOUNT_ID=… \
  node examples/escrow/agent/seller.mts --job 1                      # add --off-brief for a refund
node examples/escrow/agent/buyer.mts dispute --assertion <id> --evidence "…"
node examples/escrow/agent/buyer.mts job --job 1                    # status and balances
node examples/escrow/agent/buyer.mts reclaim --job 1                # after the deadline, if no result came
```

The Keeper (`typescript/apps/keeper`, with `EVM_RPC_URL` and `EVM_PRIVATE_KEY` set so the Relayer is on) does the rest.

### Against a local chain

The NEAR side can run on testnet against an EVM chain on your machine: Chain Signatures signs for any chain id, so a local anvil started as Base Sepolia accepts the real signed result.

```bash
anvil --chain-id 84532 &
export EVM_RPC_URL=http://127.0.0.1:8545 EVM_EXPLORER_TX=local: TEST_USDC=1
export EVM_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil's first dev account
./examples/escrow/demo.sh paid
```

`scripts/deploy-receiver.sh` records the Receiver in `contracts/evm/deployments/84532.json` and forge writes `contracts/evm/broadcast/`; delete both after a local run so they aren't mistaken for the Base Sepolia deployment.

## Recorded runs

Not yet run on Base Sepolia: there was no funded Base Sepolia key. Both outcomes were run on 2026-11-13 with the NEAR side on testnet (oracle `oracle-1794575543.enzure-council-a-1794575224.testnet`, real NEAR AI Verdicts, real Chain Signatures) and the EVM side on a local anvil with chain id 84532 (Receiver for the oracle's derived address `0xf4848c5be2f0bc003a4f071f10ca3a7101a41e5a`, escrow with TestUSDC). The EVM transactions exist only on that local chain. Seller `seller-1794577339.enzure-evm-1794568684.testnet`, buyer `enzure-evm-1794568684.testnet`.

| Step | Paid (Assertion 3, job 4) | Refunded (Assertion 5, job 6) |
| --- | --- | --- |
| Deliverable | three-line lighthouse poem with "beam" | two-line rhyme about cats (`--off-brief`) |
| Seller `assert_claim` with the EVM Hook | [tx](https://testnet.nearblocks.io/txns/63GHFh78pnHPTw4k8Da5fTxugSQr5QBVxmvCKs5iJMww) | [tx](https://testnet.nearblocks.io/txns/J1D24VjtYMr6gZCTQ5xesCB9GLRfNjoemNjmppqpfcFm) |
| Buyer `dispute` | [tx](https://testnet.nearblocks.io/txns/GPAnnFpLjnYKFcqUMwFV2kJPoUWoo5SxXJtWQ1oBprPr) | [tx](https://testnet.nearblocks.io/txns/GBAdABWNwNeiaf8b6Pn2JG5fAbkLuKGPqWDkMkPg4Q8W) |
| Keeper `submit_ai_verdict` | [TRUE](https://testnet.nearblocks.io/txns/Gfih85aqxw2i7QV3gg5kyBjz6kxYe5Riut4Ztq8st1AQ) | [FALSE](https://testnet.nearblocks.io/txns/6gQcPfQbLTJqFvXjYCspbumTw91LZJLAFn2fCWuTo6Vj) |
| Keeper `settle` | [tx](https://testnet.nearblocks.io/txns/9x96CvsnbXKmnyHkYneCp1CAhs55R5a1r3gXnvi8ceuQ) | [tx](https://testnet.nearblocks.io/txns/AvQVRGfo6pYEmyTpwJ6gF1WDHzYNNmz1mrPzdoxYYP7t) |
| Keeper `sign_hook` (Chain Signatures) | [tx](https://testnet.nearblocks.io/txns/CCpXe91sPPRomkqc3a7FYkg3jhzghT1io7UJj5uTdotR) | [tx](https://testnet.nearblocks.io/txns/3EVYzWeeRkMYPD6DWDEmhELwFrTiNPHWsmxujrDxEZoe) |
| Relayer `deliver` (local anvil) | `0x779493d0…f294c`, job paid | `0x702450c5…220b8`, job refunded |
| Winner `withdraw` | [seller](https://testnet.nearblocks.io/txns/5d6VzJEGzqvfQYPJyA37xtqqc3SgzTa3grDHDcNGNc8P) | [buyer](https://testnet.nearblocks.io/txns/B2TkmTRhXkTT4neTq8uodS7Jw9BZcUTMrLyuuDkCjj5r) |

To record the Base Sepolia runs, set `EVM_PRIVATE_KEY` to a funded key and run `./examples/escrow/demo.sh paid` then `./examples/escrow/demo.sh refunded` (pass the first run's `RECEIVER_ADDRESS` and `ESCROW_ADDRESS` to the second), and replace this table with the printed links.
