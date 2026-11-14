# Deployments and recorded runs

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

The Keeper's own dispute run on a development oracle is recorded in [`typescript/apps/keeper/README.md`](../typescript/apps/keeper/README.md#testnet-run).
