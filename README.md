<p align="center"><img src="assets/logo.svg" alt="Enzure" height="120"></p>

Enzure is an optimistic oracle on NEAR for the promises a contract can't check by itself. Anyone posts a bonded statement (an **Assertion**). If nobody disputes it, it settles TRUE. If someone disputes it, a NEAR AI Cloud model running in a TEE rules on it, and the NEAR contract checks the model's signature itself. The losing side can appeal to a Sputnik DAO. When the Assertion settles, the outcome is delivered to contracts on NEAR, or signed through Chain Signatures and delivered to contracts on EVM chains with no bridge.

The demo is an escrow for agent work: a buyer funds a job in test USDC, a seller agent does the work with NEAR AI and asserts that it matches the brief, the buyer disputes, the AI rules, and the escrow pays the seller or refunds the buyer.

Built for NEAR HACKATHON (2026-11-01 to 2026-11-14). Everything runs on NEAR testnet; nothing is on mainnet.

## The problem

People and AI agents make promises a contract can't check: "I delivered the work in this brief", "this event happened". UMA-style optimistic oracles send disputes to a token vote that takes days. AI judges are fast but rule off-chain, so nobody can check on-chain which model ruled on which prompt. NEAR has no live general-purpose oracle for statements, and results stay on one chain without a bridge.

## How it works

1. An **Asserter** posts the sha256 of a **Claim** with a NEAR bond (at least 1 NEAR), a **Liveness** period and a list of **Hooks**. Claim and Evidence text live in the storage service; only hashes go on-chain.
2. If nobody disputes during Liveness, the Assertion settles TRUE.
3. If a **Disputer** posts an equal bond, a **Resolver** sends the request the contract built to NEAR AI Cloud (`Qwen/Qwen3.8-27B`, temperature 0) and submits the signed answer. The contract checks the TEE signature against a **Registered Key** and accepts only TRUE, FALSE or UNRESOLVABLE.
4. The loser can appeal to the Sputnik DAO. UNRESOLVABLE, conflicting verdicts or a missing verdict go to the DAO automatically.
5. The winner gets their bond back plus half the loser's; the other half goes to the DAO treasury. Hooks deliver the outcome to NEAR contracts directly, or to EVM contracts through a Chain Signatures signature that a **Receiver** contract checks.

Anyone can call the timed methods; the Keeper, a Cloudflare Durable Object, calls them when they are due. Terms are defined in [`GLOSSARY.md`](GLOSSARY.md) and decisions in [`docs/adr/`](docs/adr/). The full lifecycle and how each NEAR feature is used are in [How Enzure works](docs/how-it-works.md).

## Status

| Part | Status |
| --- | --- |
| Oracle contract (Rust) | Deployed on testnet, governed by the DAO, no full-access keys: `oracle-1794625452.0verlabs.testnet` |
| Sputnik DAO | Deployed on testnet: `enzure-1794625452.sputnikv2.testnet` |
| Storage service (Cloudflare Worker + R2) | Deployed: `https://storage.enzure.0verlabs.com` |
| Receiver, escrow and test USDC (Solidity) | Not deployed to Base Sepolia (no funded key). The recorded runs used a local anvil chain with chain id 84532. |
| Web app and Keeper (Cloudflare) | Not deployed. Both run locally. |

All accounts, addresses and transaction links are in [Deployments and recorded runs](docs/deployments.md).

## Try it

**1. Run the tests.** Needs Rust, Foundry 1.7.1 and Vite+ ([versions](docs/toolchain.md)). The first run takes several minutes.

```bash
git submodule update --init
./scripts/test.sh
```

You see `==> All tests passed`: 52 Rust tests, 37 Foundry tests, 3 Claim template tests and 128 Vite+ tests.

**2. Read the paid escrow run on testnet.** Needs only `curl` and `jq`, no keys.

```bash
curl -s https://rpc.testnet.near.org -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"oracle-1794575543.enzure-council-a-1794575224.testnet","method_name":"get_assertion","args_base64":"eyJhc3NlcnRpb25faWQiOjN9"}}' \
  | jq '.result.result | implode | fromjson | {state, outcome, verdicts: [.ai_verdicts[].verdict], hooks}'
```

You see `"state": "settled"`, `"outcome": true`, `"verdicts": ["TRUE"]` and one EVM Hook with `"status": "signed"`.

**3. Check that only the DAO can change the oracle.**

```bash
./scripts/oracle-lockdown.sh oracle-1794575543.enzure-council-a-1794575224.testnet --verify-only
```

You see `OK: ... has no full-access keys. Only its DAO can change its code, through upgrade.`

More key-free checks, including the Claim hashes, the Chain Signatures signature and the DAO proposals, are in [Check it without keys](docs/verify.md).

**4. Run the escrow demo** (needs a funded testnet account and a NEAR AI key; see [`.env.example`](.env.example)):

```bash
cd typescript && vp install && vp run --filter @enzure/keeper build && cd ..
./examples/escrow/demo.sh paid        # the AI rules TRUE and the escrow pays the seller
./examples/escrow/demo.sh refunded    # the AI rules FALSE and the escrow refunds the buyer
```

The demo, the web app and the other testnet scripts are covered in [Run Enzure](docs/running.md).

## Trust assumptions and known gaps

- The DAO council decides Appeals, Registered Keys, config and upgrades. In the demo it is two accounts and one vote passes.
- A TEE signature proves which model answered which request. It doesn't prove the answer is right or that the software in the TEE was uncompromised. Bonds and the Appeal are the defence.
- There is no Base Sepolia deployment, and the web app and Keeper aren't hosted. Bonds are native NEAR only.

The full list is in [Trust assumptions and known gaps](docs/trust-assumptions.md).

## Repository

| Path | What it holds |
| --- | --- |
| `contracts/near/` | The oracle contract and its sandbox tests |
| `contracts/evm/` | The Receiver and the `IEnzureConsumer` interface |
| `typescript/` | `packages/core` (business logic) and `apps/` (storage, web, keeper) |
| `examples/` | The escrow demo and minimal NEAR and EVM Consumers |
| `scripts/`, `fixtures/` | Test, deploy and DAO scripts; real signed test data |

Details: [Repository layout](docs/repository-layout.md).

## Libraries and AI tools

All code was written during the hackathon, from 2026-11-12 on. Main libraries: near-sdk 5.30.1, forge-std, Vite+, Zod, viem, @noble/curves, Hono, near-kit, TanStack Start, React 19, Tailwind CSS 4 and shadcn/ui. The code, tests and docs were written mostly by AI coding agents, driven and reviewed by the team. At run time the product uses NEAR AI Cloud. The full list of libraries, templates, services and agent skills is in [Libraries, templates and AI tools](docs/credits.md).

## Hackathon tracks

- `agents` (primary): a seller agent is hired, paid or refunded through a checkable AI ruling.
- `open`: one NEAR contract settles contracts on other chains through Chain Signatures, with no bridge.
- `security`: the contract verifies TEE signatures itself, rejects any request it didn't build, and the oracle account has no full-access keys.
- `social`: a Sputnik DAO is the Appeal court and governs the oracle.

## License

[MIT](LICENSE).
