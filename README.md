<p align="center"><img src="assets/logo.svg" alt="Enzure" width="96"></p>

# Enzure

Enzure is an AI optimistic oracle on NEAR. Anyone posts a bonded statement (an **Assertion**). If nobody disputes it, it settles TRUE. If someone disputes it, a NEAR AI Cloud model running in a TEE rules on it, and the NEAR contract checks the model's signature itself. The losing side can appeal to a Sputnik DAO. When the Assertion settles, the outcome is delivered to contracts on NEAR, or signed through Chain Signatures and delivered to contracts on EVM chains with no bridge.

The demo is an escrow for agent work: a buyer funds a job in test USDC, a seller agent does the work with NEAR AI and asserts that it matches the brief, the buyer disputes, the AI rules, and the escrow pays the seller or refunds the buyer.

Built for NEAR HACKATHON (2026-11-01 to 2026-11-14). Everything runs on NEAR testnet; nothing is on mainnet.

## Status

| Part | Status |
| --- | --- |
| Oracle contract (Rust, NEAR testnet) | Deployed and governed by the DAO, with no full-access keys: `oracle-1794575543.enzure-council-a-1794575224.testnet` |
| Sputnik DAO (NEAR testnet) | Deployed: `enzure-1794575224.sputnikv2.testnet` |
| Storage service (Cloudflare Worker + R2) | Deployed: `https://enzure-storage.luckzivanius.workers.dev`, serving `GET /content/{sha256}` ([example](https://enzure-storage.luckzivanius.workers.dev/content/6737fd606296d5e1ea3ac20f470896757bf8fcd0b84b81da863b54db62178caa)) |
| Receiver, escrow and test USDC (Solidity, Base Sepolia) | **Not deployed.** There was no funded Base Sepolia key. The escrow runs below used a local anvil chain with chain id 84532 for the EVM side. |
| Web app (TanStack Start, Cloudflare) | **Not deployed.** It runs locally (see [Web app](#web-app)). |
| Keeper service (Cloudflare Workers, Durable Object alarm) | **Not deployed.** `scripts/deploy-keeper.sh` deploys it as `enzure-keeper` (ADR 0006). The recorded runs ran the Keeper locally. |
| Tests | `./scripts/test.sh` runs the Rust sandbox, Foundry and Vite+ suites. |

## The problem

People and AI agents make promises a contract can't check by itself: "I delivered the work in this brief", "this event happened". The current options are poor:

- UMA-style optimistic oracles accept a bonded statement unless someone disputes it. A dispute then goes to a token vote that takes days.
- AI judges, such as NEAR's Agent Market dispute resolver, are fast but rule off-chain. Nobody can check on-chain which model ruled, on which prompt, or whether it was the only ruling produced.
- NEAR has no live general-purpose oracle for statements. The oracles listed in NEAR's docs serve prices.
- Results stay on one chain. An escrow on Base can't act on a NEAR ruling without a bridge.

## How it works

The words in bold are defined in [`GLOSSARY.md`](GLOSSARY.md). Decisions are in [`docs/adr/`](docs/adr/).

1. An **Asserter** calls `assert_claim` with the sha256 of a **Claim**, optional **Evidence** hash, a NEAR bond (at least 1 NEAR), a **Liveness** period and a list of **Hooks**. Claim and Evidence text live in the storage service under their hashes; only the hashes go on-chain.
2. If nobody disputes during Liveness, anyone can call `settle` and the Assertion settles TRUE. The Asserter withdraws the bond.
3. A **Disputer** calls `dispute` during Liveness with an equal bond and its own Evidence hash. The contract records a seed from the block's random seed.
4. A **Resolver** (anyone; the Keeper runs one) reads the exact request bytes from the `ai_request` view, sends them to NEAR AI Cloud, and submits the response and its signature with `submit_ai_verdict`. The contract checks the content hashes, that the signed text is `model_id:sha256(request):sha256(response)` for the request it built itself, that the ed25519 signature is from a **Registered Key** for the pinned model, and that the answer is exactly TRUE, FALSE or UNRESOLVABLE.
5. The loser can `appeal` during the **Appeal Window**. An UNRESOLVABLE verdict, **Conflicting Verdicts** (a second valid verdict that differs) or no verdict before the deadline send the Assertion to Appeal automatically. The DAO rules with a normal Sputnik proposal calling `resolve_appeal`. An Appeal the DAO doesn't rule on settles by itself after the DAO deadline.
6. On settlement, the winner gets their bond back plus half the loser's; the other half goes to the DAO treasury. Payouts are credited to balances and collected with `withdraw`.
7. Hooks deliver the outcome. A NEAR Hook calls `assertion_resolved` on the Consumer with fixed gas. An EVM Hook is signed with `sign_hook`, and a **Relayer** delivers it to the **Receiver** contract on the EVM chain, which checks the signature and calls the Consumer's `assertionResolvedCallback`.

Every timer is checked when a method is called. Anyone can call `settle`, `check_timeout` and `sign_hook`; the Keeper calls them when they are due.

### How the NEAR pieces are used

- **NEAR AI Cloud.** The pinned model is `Qwen/Qwen3.8-27B` (Prompt Template v1, temperature 0, structured output limited to the three verdicts). The Resolver calls it without streaming and with aliasing disabled, then fetches the `provider_tee` ed25519 signature for the chat. The contract verifies that signature with `env::ed25519_verify`. A real signed response is committed in [`fixtures/near-ai-cloud/signed-response.json`](fixtures/near-ai-cloud/signed-response.json), and the sandbox tests check that the contract rebuilds its request bytes exactly and accepts its signature. The escrow demo's seller agent also uses NEAR AI Cloud to write the deliverable.
- **Chain Signatures.** `sign_hook` asks `v1.signer-prod.testnet` to sign the keccak256 digest of a fixed 288-byte result message (chain id, Receiver, Consumer, Assertion id, outcome, Claim hash, Asserter hash, settlement time), with path `enzure-hooks-evm` and domain 0. The oracle has the same derived EVM address on every EVM chain, and the Receiver accepts only results that `ecrecover` to it. The oracle has no method that signs bytes a caller supplies. A real testnet signing is committed in [`fixtures/chain-signatures/signed-result.json`](fixtures/chain-signatures/signed-result.json); the Rust and Solidity tests both check it.
- **Sputnik DAO.** A Sputnik DAO v2 (factory `sputnikv2.testnet`) is the oracle's DAO and treasury. Through ordinary `FunctionCall` proposals it adds and removes Registered Keys, publishes Prompt Templates, sets the config, rules on Appeals and upgrades the contract. After the first deploy the oracle account's full-access keys were deleted, so the DAO is the only way to change its code (ADR 0004).

## Check it without keys

These need only a shell with `curl` and `jq`; the `near` commands need [near-cli-rs](https://github.com/near/near-cli-rs) 0.31 and the `cast` commands need [Foundry](https://github.com/foundry-rs/foundry). Nothing here signs a transaction. Each was run on 2026-11-13.

**1. Read the oracle's config.** It shows the DAO and the demo timers (seconds):

```bash
near contract call-function as-read-only oracle-1794575543.enzure-council-a-1794575224.testnet \
  get_config json-args '{}' network-config testnet now
```

You see `"dao": "enzure-1794575224.sputnikv2.testnet"`, `"default_liveness": 120`, `"appeal_window": 60`, `"ai_verdict_deadline": 60`, `"dao_deadline": 600`, `"min_bond": "1000000000000000000000000"` (1 NEAR).

**2. Check that nobody holds a full-access key to the oracle.**

```bash
./scripts/oracle-lockdown.sh oracle-1794575543.enzure-council-a-1794575224.testnet --verify-only
```

You see `OK: oracle-1794575543.enzure-council-a-1794575224.testnet has no full-access keys. Only its DAO can change its code, through upgrade.` `near account list-keys oracle-1794575543.enzure-council-a-1794575224.testnet network-config testnet now` shows an empty key table.

**3. Read the paid run's Assertion** (Assertion 3, from the escrow demo), without the near CLI:

```bash
curl -s https://rpc.testnet.near.org -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"oracle-1794575543.enzure-council-a-1794575224.testnet","method_name":"get_assertion","args_base64":"eyJhc3NlcnRpb25faWQiOjN9"}}' \
  | jq '.result.result | implode | fromjson | {state, outcome, claim_hash, evidence_hash, disputer: .dispute.disputer, verdicts: [.ai_verdicts[].verdict], hooks}'
```

(`eyJhc3NlcnRpb25faWQiOjN9` is base64 of `{"assertion_id":3}`.) You see `"state": "settled"`, `"outcome": true`, `"verdicts": ["TRUE"]`, the Claim hash `6737fd60…8caa` and one EVM Hook with `"status": "signed"`. With `"args_base64":"eyJhc3NlcnRpb25faWQiOjV9"` (Assertion 5, the refunded run) you see `"outcome": false` and `["FALSE"]`. Assertion 1 (`eyJhc3NlcnRpb25faWQiOjF9`) went to the DAO: its `appeal.reason` is `"no_verdict"` and its `outcome` is `true`.

**4. Read the Claim and Evidence and check their hashes.**

```bash
curl -s https://enzure-storage.luckzivanius.workers.dev/content/6737fd606296d5e1ea3ac20f470896757bf8fcd0b84b81da863b54db62178caa | tee /dev/stderr | shasum -a 256
./scripts/storage-download.sh 48557b6df9e88a074c9ee5268b839c214475173db4f1b367588265321da5c387    # the seller's poem
./scripts/storage-download.sh b86abc87fddaf53c8c9cdd917f62978c3d5f62810261f5b7c6dc3396dcb36ad1    # the buyer's Evidence
```

The first prints the Claim (escrow job 4, the brief "Write a short poem about a lighthouse at night. It must have exactly three lines and use the word "beam".") and the same hash as `claim_hash`. `storage-download.sh` prints the content and `verified <hash>`; it writes nothing if the bytes don't match.

**5. Check the Chain Signatures signature on the paid result.** Read the signed result, recompute its digest, and recover the signer:

```bash
near contract call-function as-read-only oracle-1794575543.enzure-council-a-1794575224.testnet \
  get_signed_result json-args '{"assertion_id":3,"hook_index":0}' network-config testnet now
cast keccak 0x5686139c8eb1de3c99cb20b4b2940863b1c8903c4e9c388ad77ceb4908cb41d40000000000000000000000000000000000000000000000000000000000014a340000000000000000000000005fbdb2315678afecb367f032d93f642f64180aa30000000000000000000000000dcd1bf9a1b36ce34237eeafef220932846bcd82000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000016737fd606296d5e1ea3ac20f470896757bf8fcd0b84b81da863b54db62178caa2059845b5396d1e65ad0168146abf146ecedca64315b00d884b9ffcb9accdb21000000000000000000000000000000000000000000000000000000006af71589
cast wallet verify --no-hash --address 0xf4848c5be2f0bc003a4f071f10ca3a7101a41e5a \
  0x4fe50bc7f98438018280dd05da0b63075e3702864eaa637799a1716f5a6992c7 \
  0x701ade53bdd2caa5a3863cc694f7857f71996aa4012324155eb2db7a6383f75b65c06270988e989f14c5147dfbeaf624d44aee3f83319ce9f6a45bdb41f174291c
```

The first prints the result with its `message`, `digest`, `r`, `s` and `v` (28). `cast keccak` of the `message` prints the `digest`, `0x4fe50bc7…92c7`. `cast wallet verify` prints `Validation succeeded. Address 0xF4848C5Be2F0bC003a4f071F10CA3a7101a41e5A signed this message.` (the signature argument is `r`, `s` and `v` = `0x1c`). That address is the oracle's derived address; after `cd typescript && vp install`, `node scripts/oracle-evm-address.mts oracle-1794575543.enzure-council-a-1794575224.testnet` derives it from the signer's `derived_public_key` and prints `"address": "0xf4848c5be2f0bc003a4f071f10ca3a7101a41e5a"`.

**6. Read the DAO's proposals.**

```bash
near contract call-function as-read-only enzure-1794575224.sputnikv2.testnet \
  get_proposals json-args '{"from_index":0,"limit":10}' network-config testnet now
```

You see proposals 0 to 4, all `"status": "Approved"`: register the attested key, publish Prompt Template v1, set the demo config, `resolve_appeal` for Assertion 1, and `upgrade`. `get_registered_keys` and `get_prompt_template` on the oracle show the results of proposals 0 and 1.

**7. Open the finished transactions** in the tables under [Recorded testnet runs](#recorded-testnet-runs). Each link opens NearBlocks.

## Run the tests

```bash
git submodule update --init
./scripts/test.sh
```

It needs Rust (rustup; `contracts/near/rust-toolchain.toml` pins 1.95.0 with `wasm32-unknown-unknown`), Foundry 1.7.1 and Vite+ (`vp`, which downloads Node 26.13.1 and pnpm). Versions are in [`docs/toolchain.md`](docs/toolchain.md). The first run needs network access for crates, forge-std, npm packages and the NEAR sandbox binary, and takes several minutes because the sandbox tests build the contracts to Wasm.

It runs, in order:

- the oracle's Rust unit tests and NEAR sandbox tests (`contracts/near`): the whole lifecycle, every AI Verdict rejection, Appeal and DAO paths, bond splits, NEAR Hook failure and retry, `sign_hook` with a mock Chain Signatures signer, DAO-only methods, upgrade, and the two real fixtures;
- the Foundry tests of the Receiver (`contracts/evm`), the example EVM Consumer (`examples/evm-consumer`) and the escrow (`examples/escrow`), including the real testnet signature delivered through the real Receiver;
- the escrow demo's Claim template tests (`node --test`);
- `vp check` (format, lint, types) and `vp test` in `typescript/`: core, the storage service in the Workers runtime, and the Keeper's config.

You see `==> All tests passed` at the end. The script exits non-zero on the first failure. On 2026-11-13 it ran 52 Rust tests, 37 Foundry tests (18 Receiver, 3 example Consumer, 16 escrow), 3 Claim template tests and 128 Vite+ tests in 16 files, all passing.

## Run the testnet demo

The escrow demo needs keys, so a judge can follow the [recorded runs](#recorded-testnet-runs) instead. To run it yourself:

```bash
cd typescript && vp install && vp run --filter @enzure/keeper build && cd ..
./examples/escrow/demo.sh paid        # honest seller: the AI rules TRUE and the escrow pays the seller
./examples/escrow/demo.sh refunded    # the seller writes about cats instead: the AI rules FALSE and the escrow refunds the buyer
```

It reads from the environment or a root `.env` (see [`.env.example`](.env.example)): `NEAR_ACCOUNT_ID` and `NEAR_PRIVATE_KEY` (a funded testnet account, about 3 NEAR per run, 1.5 of which comes back), `NEARAI_API_KEY`, and `EVM_PRIVATE_KEY` (Base Sepolia ETH and [Circle test USDC](https://faucet.circle.com), or `TEST_USDC=1` to deploy a mintable token). Without them it stops and names the first missing variable. A run takes about 3 minutes: it deploys the Receiver and the escrow, creates the job, starts the Keeper, has the seller agent post the Assertion, disputes it as the buyer, and waits until the Keeper has submitted the AI Verdict, settled, signed the Hook and delivered it. It prints every NEAR and EVM link and the escrow's balances.

To run the EVM side on your machine instead of Base Sepolia, start `anvil --chain-id 84532` and set `EVM_RPC_URL=http://127.0.0.1:8545 EVM_EXPLORER_TX=local: TEST_USDC=1` and anvil's first dev key as `EVM_PRIVATE_KEY`. That is how the recorded runs were made. Details: [`examples/escrow/README.md`](examples/escrow/README.md).

Other testnet scripts, each documented in [`scripts/README.md`](scripts/README.md):

- `./scripts/keeper-dispute.sh`: deploys a development oracle, posts and disputes an Assertion, and runs the Keeper until it has submitted the AI Verdict and settled.
- `./scripts/dao-appeal.sh <dao> <oracle>`: posts and disputes an Assertion, lets the AI Verdict deadline pass, calls `check_timeout`, and rules it through a `resolve_appeal` proposal.
- `./scripts/dao-setup.sh`, `dao-propose.sh`, `dao-approve.sh`, `oracle-lockdown.sh`: create the DAO and oracle, govern it, and delete the oracle's full-access keys.
- `node --env-file-if-exists=.env scripts/check-near-ai-signing.mts`: checks that NEAR AI Cloud signs the exact request and response bytes (needs `NEARAI_API_KEY`).

## Web app

The web app isn't hosted. Run it locally against the deployed oracle and storage service:

```bash
cd typescript && vp install
cd apps/web
ORACLE_ACCOUNT_ID=oracle-1794575543.enzure-council-a-1794575224.testnet \
STORAGE_URL=https://enzure-storage.luckzivanius.workers.dev vp exec cf dev
```

Open http://localhost:3000. The storage service's CORS list allows ports 3000 and 5173; if 3000 is taken, add `--port 5173` to the last command. You see:

- `/`: the oracle's Assertions, newest first.
- `/assertions/3`: "Settled TRUE", a timeline (Posted, Liveness stopped by a dispute, Disputed, AI Verdict 1 TRUE with the signing key, Appeal Window closed, Settled, EVM Hook 1) with a NearBlocks link on each step, and the Claim and both Evidence items, each marked "Matches hash". The EVM Hook step shows the signed result and "No Receiver contract at 0x5fbdb2315678afecb367f032d93f642f64180aa3", because the recorded runs delivered to a local chain, not Base Sepolia.
- `/assertions/1`: "In Appeal: No AI Verdict arrived before its deadline", then "DAO ruled TRUE" with Proposal 3, the transaction that created it and the one that approved it. Its Claim shows "Not available", because the DAO script didn't upload it.

Connect a NEAR testnet wallet to post (`/assert`), dispute, Appeal and withdraw. Details: [`typescript/apps/web/README.md`](typescript/apps/web/README.md).

`./scripts/deploy-web.sh` deploys it as the Worker `enzure-web` with Cloudflare credentials; `./scripts/deploy-web.sh mainnet` deploys `enzure-web-mainnet` from `.env.mainnet`. Every deploy script takes `testnet` (the default) or `mainnet` this way ([`scripts/README.md`](scripts/README.md)).

## Deployed accounts and addresses

All on NEAR testnet unless noted.

| What | Account or address | Notes |
| --- | --- | --- |
| Oracle | `oracle-1794575543.enzure-council-a-1794575224.testnet` | The demo oracle. DAO-governed, no full-access keys, upgraded once by the DAO (code sha256 `64a8cb91e06bf8411d6fe5a6561e7208e59ac804586640241d706524bb7e010f`). Registered Key `89154a43a47684742c3d1753252bb6f49f61da9d8c84fc9b1def2df130cb2d93` for `Qwen/Qwen3.8-27B`, Prompt Template v1. |
| DAO | `enzure-1794575224.sputnikv2.testnet` | Sputnik DAO v2, treasury of the oracle. One `council` role; one vote passes a proposal, so the demo is quick. |
| DAO council | `enzure-council-a-1794575224.testnet`, `enzure-council-b-1794575224.testnet` | Faucet accounts. |
| Oracle's EVM address | `0xf4848c5be2f0bc003a4f071f10ca3a7101a41e5a` | Derived by Chain Signatures (`v1.signer-prod.testnet`, path `enzure-hooks-evm`, domain 0). A Receiver for this oracle must be deployed with this address. |
| Storage service | `https://enzure-storage.luckzivanius.workers.dev` | `PUT`/`GET /content/{sha256}`; other paths return 404. Cloudflare Worker with R2. |
| Receiver, escrow, test USDC on Base Sepolia (84532) | none | Not deployed. `scripts/deploy-receiver.sh` and `examples/escrow/demo.sh` deploy them with a funded key. The addresses in Assertions 2 to 5 (`0x5fbdb231…0aa3`, `0x0dcd1bf9…cd82`) are on a local anvil chain and have no code on Base Sepolia. |
| Web app | none | Not deployed (would be `enzure-web` on Cloudflare Workers). |
| Keeper | none | Not deployed (Worker `enzure-keeper`, `typescript/apps/keeper`). |
| Development oracles | `oracle-1794571590.enzure-keeper-1794571407.testnet`, `oracle-1794568696.enzure-evm-1794568684.testnet` | Used for the Keeper run and the Chain Signatures fixture. Their DAO is a single account and they still have full-access keys; they are not the demo deployment. |

## Recorded testnet runs

All on 2026-11-13. The NEAR side (oracle, NEAR AI Cloud, Chain Signatures, DAO) is real testnet. The links were checked against the FastNEAR and NearBlocks APIs.

### Escrow: paid and refunded

Oracle `oracle-1794575543.enzure-council-a-1794575224.testnet`. Seller `seller-1794577339.enzure-evm-1794568684.testnet`, buyer `enzure-evm-1794568684.testnet`. The EVM side ran on a local anvil chain with chain id 84532, so the Relayer's `deliver` transactions exist only there; no Base Sepolia transactions exist yet.

| Step | Paid (Assertion 3, job 4) | Refunded (Assertion 5, job 6) |
| --- | --- | --- |
| Deliverable | three-line lighthouse poem with "beam" | two-line rhyme about cats |
| Seller `assert_claim` with the EVM Hook | [tx](https://testnet.nearblocks.io/txns/63GHFh78pnHPTw4k8Da5fTxugSQr5QBVxmvCKs5iJMww) | [tx](https://testnet.nearblocks.io/txns/J1D24VjtYMr6gZCTQ5xesCB9GLRfNjoemNjmppqpfcFm) |
| Buyer `dispute` | [tx](https://testnet.nearblocks.io/txns/GPAnnFpLjnYKFcqUMwFV2kJPoUWoo5SxXJtWQ1oBprPr) | [tx](https://testnet.nearblocks.io/txns/GBAdABWNwNeiaf8b6Pn2JG5fAbkLuKGPqWDkMkPg4Q8W) |
| Keeper `submit_ai_verdict` | [TRUE](https://testnet.nearblocks.io/txns/Gfih85aqxw2i7QV3gg5kyBjz6kxYe5Riut4Ztq8st1AQ) | [FALSE](https://testnet.nearblocks.io/txns/6gQcPfQbLTJqFvXjYCspbumTw91LZJLAFn2fCWuTo6Vj) |
| Keeper `settle` | [tx](https://testnet.nearblocks.io/txns/9x96CvsnbXKmnyHkYneCp1CAhs55R5a1r3gXnvi8ceuQ) | [tx](https://testnet.nearblocks.io/txns/AvQVRGfo6pYEmyTpwJ6gF1WDHzYNNmz1mrPzdoxYYP7t) |
| Keeper `sign_hook` (Chain Signatures) | [tx](https://testnet.nearblocks.io/txns/CCpXe91sPPRomkqc3a7FYkg3jhzghT1io7UJj5uTdotR) | [tx](https://testnet.nearblocks.io/txns/3EVYzWeeRkMYPD6DWDEmhELwFrTiNPHWsmxujrDxEZoe) |
| Relayer `deliver` to the Receiver | local anvil only: job paid | local anvil only: job refunded |
| Winner `withdraw` | [seller](https://testnet.nearblocks.io/txns/5d6VzJEGzqvfQYPJyA37xtqqc3SgzTa3grDHDcNGNc8P) | [buyer](https://testnet.nearblocks.io/txns/B2TkmTRhXkTT4neTq8uodS7Jw9BZcUTMrLyuuDkCjj5r) |

### Appeal ruled by the DAO

Assertion 1 on the same oracle: disputed, no AI Verdict before the deadline, sent to Appeal by `check_timeout`, ruled TRUE by DAO proposal 3. The Asserter was credited 1.5 NEAR and the DAO 0.5 NEAR.

| Step | Transactions |
| --- | --- |
| Post, dispute, `check_timeout` | [post](https://testnet.nearblocks.io/txns/5qxhhAbnc8RHhoC9o3BzL2XswCZtmb8bkq2SoghaCgLm), [dispute](https://testnet.nearblocks.io/txns/Ab9Gkd3WgLBk2SkZFmJBgAweK9sRuh3tpckWgHLByBd4), [check_timeout](https://testnet.nearblocks.io/txns/KkfUyVP4w5iomdt3gs8KzfywncVFxsKUCXd6P7dLg1L) |
| Proposal 3, `resolve_appeal(1, true)` | [propose](https://testnet.nearblocks.io/txns/FzBRNoJQnbKj8DZWSvQkpkds6R1jMK7ZE5u5yJndyoNZ), [approve](https://testnet.nearblocks.io/txns/BQysmRoouCcBBF4hhfRftkbGdycssxykDoZ1DwAk9JZj), [withdraw](https://testnet.nearblocks.io/txns/DK9mQnoed3AqhBfNakWxaeQWGgBdBJU7Pt1HSnb1ez62) |

### DAO set-up and lockdown

| Step | Transactions |
| --- | --- |
| Create the DAO | [create](https://testnet.nearblocks.io/txns/8EDHbqUeUUF7jWhjJ91QdiGm3thDU6ATsSBeofiH1yWo) |
| Deploy the oracle with the DAO as DAO and treasury | [create account](https://testnet.nearblocks.io/txns/9rK86empQWL6CQRumveNPFxJNm6BMuoD4ZZJvFb2jt92), [deploy](https://testnet.nearblocks.io/txns/Ex4VzRyznsb9KESfQwS7bGn5osSeiGLHngcwp2yMvo28) |
| Proposal 0: register the attested key | [propose](https://testnet.nearblocks.io/txns/4tF83vtyMECV5dsF7KdZbJTLXgDdTKvPhPuD57EkrpyL), [approve](https://testnet.nearblocks.io/txns/EGL3DtNLVYviM76cyLc5qbnpxzbYMwT2uHunPih8r6Dv) |
| Proposal 1: publish Prompt Template v1 | [propose](https://testnet.nearblocks.io/txns/5LyAfo3JiA8n8qLg1kzjqaYgzr5GrJvRxWwR5pi89588), [approve](https://testnet.nearblocks.io/txns/6N3VoVB426PoEjYJBYqKTTrT5JvHsAiXUZ8ZtHBxihzS) |
| Proposal 2: demo config | [propose](https://testnet.nearblocks.io/txns/E1nD8USCxXchNrKp3fLvrwX5EfgMWzC3kDc3Wp57QScS), [approve](https://testnet.nearblocks.io/txns/DNYDHMJY4pKmSF7MojvNrvcgdqDSJrMA5Wf2cXJ2VdVS) |
| Delete the oracle's only full-access key | [delete key](https://testnet.nearblocks.io/txns/5JhwhP5Vuh2uL3jHqKFBSujQqyJ7RF5AAX4tgku8Hs6B) |
| Proposal 4: `upgrade` the locked oracle | [fund DAO storage](https://testnet.nearblocks.io/txns/BtF7sE6fsbnetbEUHuFtuye7UYQZGPXXh7qaK5P25TcF), [propose](https://testnet.nearblocks.io/txns/wHmmkfpufYmdbBvsoVgWV3XS68Pg2Are2edytc5vTpg), [approve](https://testnet.nearblocks.io/txns/GHemfarupRgLTGuZb1p2fRKazNQxPVyVwK3bjF1xF9bL) |

In the upgrade approval, the oracle deployed the new code and logged `contract_upgraded`; the DAO's own follow-up callback in the same transaction ran out of gas, so NearBlocks shows one failed receipt. The proposal is recorded as `Approved`.

The Keeper's own dispute run on a development oracle is recorded in [`typescript/apps/keeper/README.md`](typescript/apps/keeper/README.md#testnet-run).

## Trust assumptions

- **The DAO council decides Appeals and Registered Keys.** It also sets the timers and bonds, publishes Prompt Templates and can upgrade the contract. In the demo the council is two accounts and one vote passes, so whoever holds either key controls the oracle.
- **A TEE signature proves which model produced which response to which request. It does not prove the answer is right.** The model can be wrong or be talked round by text in the Claim or Evidence; the prompt marks both as data, which reduces prompt injection but doesn't stop it. Bonds and the Appeal are the defence.
- **A TEE signature doesn't prove the software inside the TEE was uncompromised.** NEAR AI's own [security incident report](https://near.ai/blog/security-incident-report-sglang-vulnerability) (November 2026) says an attacker exploited a remote code execution vulnerability in SGLang, the open-source inference engine running on its servers, which gave them code execution on one inference server. On November 8, it says, they could also have observed user requests being processed on that server, including requests running in confidential mode. The report says confidential computing does not protect against a vulnerability in the software running inside the environment. It doesn't say signing keys were exposed. Enzure's answer is the same as for a wrong answer: bonds, Appeal, and the DAO removing a key.
- **Registered Keys are checked off-chain by whoever proposes them.** `scripts/near-ai-attested-key.mts` fetches the model's attestation with a fresh nonce and checks that the TDX quote's report data binds the signing key to that nonce. It doesn't verify Intel's signature over the quote or the GPU attestation, and the contract doesn't verify attestation at all. Council members are trusted to check before voting.
- **Verdict shopping is limited, not prevented.** A Resolver could ask the model many times and submit only the answer it likes. The contract builds the request itself with temperature 0 and a seed it chose at dispute time, and a second valid verdict that differs (Conflicting Verdicts) sends the Assertion to the DAO. Someone has to submit that second verdict for this to work.
- **The demo oracle account has no full-access keys** (step 2 above), so only DAO proposals can change its code or state. The development oracles still have full-access keys.
- **Chain Signatures and the Receiver.** An EVM Consumer trusts that only the oracle can get a signature from its derived address, which rests on the Chain Signatures MPC network. Moving the oracle to a new account changes that address and needs a new Receiver.
- **The escrow can't require a minimum Liveness.** The signed result message carries no Liveness, so the example escrow can't check how long the seller's Assertion was open to dispute. A seller could assert with the oracle's 1-minute minimum Liveness, so the buyer has to watch the oracle and dispute within that time. The demo buyer disputes as soon as the seller has asserted.
- **The storage service is a convenience, not a trust point.** Content is checked against its on-chain hash by the service, the web app, the Keeper and the scripts. If content is missing, the Assertion gets no AI Verdict and goes to the DAO after the deadline.
- **Nobody has to run the Keeper.** `settle`, `check_timeout`, `sign_hook`, `submit_ai_verdict` and Relayer delivery are open to anyone.
- **Demo timers are short.** The demo oracle uses 120 s Liveness, a 60 s Appeal Window and AI Verdict deadline, and a 600 s DAO deadline. The contract's defaults are 2 hours, 24 hours, 1 hour and 7 days.

## Known gaps

- No Base Sepolia deployment or transactions: no funded Base Sepolia key was available. The EVM side of the escrow runs was a local chain with Base Sepolia's chain id.
- The web app and the Keeper aren't hosted.
- The Keeper's Resolver doesn't submit second verdicts, so Conflicting Verdicts need someone else to submit one. They are covered by the sandbox tests.
- Bonds are native NEAR only. No mainnet, no NEAR Intents.

## Repository layout

The layout follows [ADR 0005](docs/adr/0005-hybrid-monorepo-layout-and-stack.md): contracts by chain, one TypeScript workspace with the business logic in `core`, and everything that doesn't ship kept outside both.

| Path | What it holds | Runs on |
| --- | --- | --- |
| `contracts/near/oracle/` | The oracle contract (Rust, near-sdk 5.30.1, cargo-near) and its sandbox tests. Test-only contracts (mock Chain Signatures signer, test Consumers) are in `oracle/tests/contracts/`. | NEAR testnet |
| `contracts/evm/` | The Receiver and the `IEnzureConsumer` interface (Solidity 0.8.30, Foundry), with tests and a deploy script. | Any EVM chain; Base Sepolia planned |
| `typescript/packages/core/` | Business logic as functions: building the AI request, checking signatures, encoding the result message, deciding which calls are due, reading oracle state, the Resolver and Relayer. | Library |
| `typescript/apps/storage/` | Storage service: Hono with Zod on a Cloudflare Worker with R2. | Cloudflare (deployed) |
| `typescript/apps/web/` | Web app: TanStack Start with Tailwind and shadcn/ui, NEAR wallet connection. | Cloudflare (not deployed) |
| `typescript/apps/keeper/` | Keeper: Resolver, Scheduler and a Relayer per chain, run by a Durable Object alarm, with near-kit and viem. | Cloudflare (not deployed) |
| `examples/escrow/` | The escrow demo: escrow and test USDC (Foundry), buyer script, seller agent, `demo.sh`. | Base Sepolia (planned), local |
| `examples/near-consumer/`, `examples/evm-consumer/` | Minimal Consumers for NEAR Hooks and EVM Hooks. | |
| `scripts/` | Test, deploy, DAO and check scripts. `scripts/test.sh` runs every suite. | Your machine |
| `fixtures/` | Real signed data shared by the Rust, Solidity and TypeScript tests. | |
| `docs/` | ADRs, research and the toolchain. `GLOSSARY.md` defines the terms. | |

## Libraries, templates and AI tools

All code in this repository was written from 2026-11-12 on, during the hackathon. There is no pre-hackathon code and no earlier product.

**Libraries** (versions from the lockfiles and manifests):

- NEAR contract: [near-sdk](https://github.com/near/near-sdk-rs) 5.30.1. Tests: near-sandbox 0.4, near-api 0.8, cargo-near-build 0.11, tokio, testresult, serde, serde_json, k256 and sha3 (also in the test-only mock signer), ed25519-dalek, sha2, hex. Example NEAR Consumer: near-sdk.
- EVM contracts: [forge-std](https://github.com/foundry-rs/forge-std) v1.17.0 (git submodule), built and tested with Foundry 1.7.1 and solc 0.8.30. No other Solidity libraries.
- TypeScript workspace: [Vite+](https://viteplus.dev) 1.6.0 with pnpm, TypeScript, Zod 4.
  - core: @noble/curves, @noble/hashes, [viem](https://viem.sh).
  - storage: [Hono](https://hono.dev), @hono/zod-validator, the Cloudflare CLI `cf`, @cloudflare/vite-plugin, @cloudflare/vitest-plugin.
  - keeper: [near-kit](https://kit.near.tools), viem.
  - web: [TanStack Start](https://tanstack.com/start) and TanStack Router, React 19, Tailwind CSS 4, [shadcn/ui](https://ui.shadcn.com) with radix-ui, class-variance-authority, lucide-react, tw-animate-css, the Geist font (@fontsource-variable/geist), @hot-labs/near-connect, near-connect-hooks, near-api-js.
- Escrow demo scripts: plain Node, loading viem from core and near-kit from the Keeper.
- Services used: NEAR AI Cloud, NEAR Chain Signatures (`v1.signer-prod.testnet`), Sputnik DAO v2 (`sputnikv2.testnet`), FastNEAR RPC and transactions API, NearBlocks, Blockscout's Base Sepolia API, Circle's test USDC faucet, Cloudflare Workers, Durable Objects and R2.

**Templates and generated code:**

- `contracts/near/oracle/Cargo.toml` and the workspace release profile follow the `cargo near new` template; `contracts/evm/foundry.toml` follows `forge init`.
- `typescript/apps/web/src/components/ui/` holds shadcn/ui components generated by the shadcn CLI (style `radix-nova`). `src/routeTree.gen.ts` is generated by TanStack Router.

**AI tools:**

- The code, tests and docs were written mostly by AI coding agents, driven and reviewed by the team, using the agent skills listed in [`skills-lock.json`](skills-lock.json) (from `mattpocock/skills`, `cloudflare/skills`, `near/agent-skills`, `honojs/skills`, `TanStack/router`, `shadcn-ui/ui`, `shadcn/improve`, `Leonxlnx/taste-skill` and `benjitaylor/skills`), installed under `.agents/skills/`.
- At run time the product uses NEAR AI Cloud (`Qwen/Qwen3.8-27B`) for AI Verdicts and for the demo seller agent's work.

## Hackathon tracks

- `agents` (primary): a seller agent is hired, paid or refunded through a checkable AI ruling.
- `open`: one NEAR contract settles contracts on other chains through Chain Signatures, with no bridge.
- `security`: the contract verifies TEE signatures itself, rejects any request it didn't build, and the oracle account has no full-access keys.
- `social`: a Sputnik DAO is the Appeal court and governs the oracle.

## License

[MIT](LICENSE).
