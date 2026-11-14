# How Enzure works

## The problem

People and AI agents make promises a contract can't check by itself: "I delivered the work in this brief", "this event happened". The current options are poor:

- UMA-style optimistic oracles accept a bonded statement unless someone disputes it. A dispute then goes to a token vote that takes days.
- AI judges, such as NEAR's Agent Market dispute resolver, are fast but rule off-chain. Nobody can check on-chain which model ruled, on which prompt, or whether it was the only ruling produced.
- NEAR has no live general-purpose oracle for statements. The oracles listed in NEAR's docs serve prices.
- Results stay on one chain. An escrow on Base can't act on a NEAR ruling without a bridge.

## Lifecycle

The words in bold are defined in [`GLOSSARY.md`](../GLOSSARY.md). Decisions are in [`docs/adr/`](adr/).

1. An **Asserter** calls `assert_claim` with the sha256 of a **Claim**, optional **Evidence** hash, a NEAR bond (at least 1 NEAR), a **Liveness** period and a list of **Hooks**. Claim and Evidence text live in the storage service under their hashes; only the hashes go on-chain.
2. If nobody disputes during Liveness, anyone can call `settle` and the Assertion settles TRUE. The Asserter withdraws the bond.
3. A **Disputer** calls `dispute` during Liveness with an equal bond and its own Evidence hash. The contract records a seed from the block's random seed.
4. A **Resolver** (anyone; the Keeper runs one) reads the exact request bytes from the `ai_request` view, sends them to NEAR AI Cloud, and submits the response and its signature with `submit_ai_verdict`. The contract checks the content hashes, that the signed text is `model_id:sha256(request):sha256(response)` for the request it built itself, that the ed25519 signature is from a **Registered Key** for the pinned model, and that the answer is exactly TRUE, FALSE or UNRESOLVABLE.
5. The loser can `appeal` during the **Appeal Window**. An UNRESOLVABLE verdict, **Conflicting Verdicts** (a second valid verdict that differs) or no verdict before the deadline send the Assertion to Appeal automatically. The DAO rules with a normal Sputnik proposal calling `resolve_appeal`. An Appeal the DAO doesn't rule on settles by itself after the DAO deadline.
6. On settlement, the winner gets their bond back plus half the loser's; the other half goes to the DAO treasury. Payouts are credited to balances and collected with `withdraw`.
7. Hooks deliver the outcome. A NEAR Hook calls `assertion_resolved` on the Consumer with fixed gas. An EVM Hook is signed with `sign_hook`, and a **Relayer** delivers it to the **Receiver** contract on the EVM chain, which checks the signature and calls the Consumer's `assertionResolvedCallback`.

Every timer is checked when a method is called. Anyone can call `settle`, `check_timeout` and `sign_hook`; the Keeper calls them when they are due.

## How the NEAR pieces are used

- **NEAR AI Cloud.** The pinned model is `Qwen/Qwen3.8-27B` (Prompt Template v1, temperature 0, structured output limited to the three verdicts). The Resolver calls it without streaming and with aliasing disabled, then fetches the `provider_tee` ed25519 signature for the chat. The contract verifies that signature with `env::ed25519_verify`. A real signed response is committed in [`fixtures/near-ai-cloud/signed-response.json`](../fixtures/near-ai-cloud/signed-response.json), and the sandbox tests check that the contract rebuilds its request bytes exactly and accepts its signature. The escrow demo's seller agent also uses NEAR AI Cloud to write the deliverable.
- **Chain Signatures.** `sign_hook` asks `v1.signer-prod.testnet` to sign the keccak256 digest of a fixed 288-byte result message (chain id, Receiver, Consumer, Assertion id, outcome, Claim hash, Asserter hash, settlement time), with path `enzure-hooks-evm` and domain 0. The oracle has the same derived EVM address on every EVM chain, and the Receiver accepts only results that `ecrecover` to it. The oracle has no method that signs bytes a caller supplies. A real testnet signing is committed in [`fixtures/chain-signatures/signed-result.json`](../fixtures/chain-signatures/signed-result.json); the Rust and Solidity tests both check it.
- **Sputnik DAO.** A Sputnik DAO v2 (factory `sputnikv2.testnet`) is the oracle's DAO and treasury. Through ordinary `FunctionCall` proposals it adds and removes Registered Keys, publishes Prompt Templates, sets the config, rules on Appeals and upgrades the contract. After the first deploy the oracle account's full-access keys were deleted, so the DAO is the only way to change its code (ADR 0004).
