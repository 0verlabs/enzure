# @enzure/keeper

The Keeper service: one long-lived Node process that resolves disputes and keeps Assertions moving, so a dispute settles on testnet with nobody clicking anything. It runs as a Render background worker (`render.yaml` at the repository root). Its decisions live in `@enzure/core`; this app supplies configuration, keys and the polling loop (`src/main.ts`).

Every `POLL_INTERVAL_MS` it reads all Assertions with `list_assertions` (there is no indexer, so a dispute shows up as an Assertion in state `disputed`) and runs, in order:

- **Scheduler** (`dueCalls`): `settle` once Liveness, the Appeal Window or an Appeal's DAO deadline (`appeal.dao_deadline_ns`) has ended, `check_timeout` for a disputed Assertion with no AI Verdict once its `dispute.ai_verdict_deadline_ns` has passed, and `sign_hook` for unsigned EVM Hooks of settled Assertions, and `retry_near_hook` for pending NEAR Hooks of settled Assertions (a DAO ruling whose proposal had too little gas leaves them). Deadlines come from the Assertion view, where the oracle fixes them when each timer starts, and are compared with the latest block's time.
- **Resolver** (`createResolver`): for each disputed Assertion without an AI Verdict, downloads the Claim and both Evidence items from storage and refuses any whose sha256 doesn't match, gets the exact request bytes from the `ai_request` view, sends them unchanged to NEAR AI Cloud (no streaming, `x-no-aliasing: true`), reads the ed25519 signature (retrying for up to 30 s), checks it against the oracle's Registered Keys and submits `submit_ai_verdict` with 300 TGas. Missing, oversized or mismatched content is logged and the Assertion is left for the AI Verdict deadline to send to Appeal. Each Assertion is handled once per process; failures (a service down, a rejected transaction) are retried on the next two passes.
- **Relayer** (`relayOnce`, only when `EVM_RPC_URL` and `EVM_PRIVATE_KEY` are set): delivers signed EVM Hooks to their Receivers.

Logs are JSON lines; every transaction is logged with its NearBlocks link.

## Configuration

Environment variables, checked with Zod at start-up (`src/config.ts`). A bad or missing value stops the process with the variable's name, never its value.

| Variable                              | Required     | Meaning                                                                                                                           |
| ------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `ORACLE_ACCOUNT_ID`                   | yes          | The oracle contract                                                                                                               |
| `NEAR_ACCOUNT_ID`, `NEAR_PRIVATE_KEY` | yes          | The account that signs and pays for the Keeper's calls, and its key (`ed25519:...`). A function-call key for the oracle is enough |
| `NEARAI_API_KEY`                      | yes          | NEAR AI Cloud API key                                                                                                             |
| `STORAGE_URL`                         | yes          | Storage service, e.g. `https://enzure-storage.luckzivanius.workers.dev`                                                           |
| `NEAR_NETWORK`                        | no           | `testnet` (default) or `mainnet`                                                                                                  |
| `NEAR_RPC_URL`                        | no           | Another NEAR RPC endpoint                                                                                                         |
| `NEAR_AI_URL`                         | no           | Defaults to `https://cloud-api.near.ai/v1`                                                                                        |
| `POLL_INTERVAL_MS`                    | no           | Default 15000, at least 1000                                                                                                      |
| `EVM_RPC_URL`, `EVM_PRIVATE_KEY`      | no, together | Turn the Relayer on; the key pays Base Sepolia gas                                                                                |

## Run

From `typescript/`:

```bash
vp install
vp run --filter @enzure/keeper build
node --env-file=../.env apps/keeper/dist/main.mjs   # ORACLE_ACCOUNT_ID etc. in the root .env
```

`vp test apps/keeper` runs the configuration tests; the Resolver and Scheduler are tested in core. The whole service is checked end to end on testnet by `scripts/keeper-dispute.sh`.

## Deploy to Render

`render.yaml` defines the worker `enzure-keeper` (Node 26.13.1, starter plan, root `typescript/`). Create a Blueprint from the repository in the Render dashboard and fill in the `sync: false` secrets when asked. The build installs pnpm 12.18.0 with npm, installs only the Keeper and core, and bundles core into `apps/keeper/dist/main.mjs`.

Not deployed yet: there are no Render credentials for this project.

## Testnet run

`scripts/keeper-dispute.sh` on 2026-11-13, with the Keeper running locally: a disputed Assertion on `oracle-1794571590.enzure-keeper-1794571407.testnet` got its AI Verdict (TRUE) from the Keeper 6 s after it started and was settled by the Keeper once the 60 s Appeal Window closed.

| Step                                           | Transaction                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `assert_claim` (Claim and Evidence in storage) | [5K1c1JNw…](https://testnet.nearblocks.io/txns/5K1c1JNwk1XPou6MMKTD34ukLKWgm7XMLMeh3aj6A2oP) |
| `dispute` with the Disputer's Evidence         | [F6dV2FrU…](https://testnet.nearblocks.io/txns/F6dV2FrUYctbGM7tfYuQNnKJ7JZTd75NCjVKMuHqirvc) |
| Keeper: `submit_ai_verdict`                    | [DHQ59uLv…](https://testnet.nearblocks.io/txns/DHQ59uLvUGDaQZ9Xvzxcvmhwf9uA2kKeGFpZ6pstEiAG) |
| Keeper: `settle`                               | [E2sMGjUx…](https://testnet.nearblocks.io/txns/E2sMGjUxaKzpwTF34Ymu9vP4QYrZ4F6agA4jctZWhCJb) |
| `withdraw`                                     | [H3pmwfZ7…](https://testnet.nearblocks.io/txns/H3pmwfZ77Vod7E1JHrpCV2eu3znCDSr9kpScGSH28gZz) |

Set-up: [deploy](https://testnet.nearblocks.io/txns/ETJegi56QshDFvtFziiYQk3tmFzWGaZ5g3h4JyazAePJ), [set_config](https://testnet.nearblocks.io/txns/4tTQSqe9oqKqwqLw9dTecVvVKBrhNgc7tkjEWdnForKs), [publish_prompt_template](https://testnet.nearblocks.io/txns/9XKxSRaMATtWUyoPLhKn7UxiuBJUw6zp5vFphdzNGwFm), [add_registered_key](https://testnet.nearblocks.io/txns/7eps83NSR2ugV6oJTHvrjWsPqV4mpK1DMDWZmeRu1iyy).
