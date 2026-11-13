# @enzure/keeper

The Keeper service resolves disputes and keeps Assertions moving, so a dispute settles on testnet with nobody clicking anything. It runs on Cloudflare Workers as the Worker `enzure-keeper`: one Durable Object whose alarm runs a pass every `POLL_INTERVAL_MS` (`src/worker.ts`). The decisions live in `@enzure/core`; this app supplies configuration, keys and the loop. The same pass (`src/keeper.ts`) also runs as a local Node process (`src/main.ts`) for development and the testnet scripts.

Every pass reads all Assertions with `list_assertions` (there is no indexer, so a dispute shows up as an Assertion in state `disputed`) and runs, in order:

- **Scheduler** (`dueCalls`): `settle` once Liveness, the Appeal Window or an Appeal's DAO deadline (`appeal.dao_deadline_ns`) has ended, `check_timeout` for a disputed Assertion with no AI Verdict once its `dispute.ai_verdict_deadline_ns` has passed, `sign_hook` for unsigned EVM Hooks of settled Assertions, and `retry_near_hook` for pending NEAR Hooks of settled Assertions (a DAO ruling whose proposal had too little gas leaves them). Deadlines come from the Assertion view, where the oracle fixes them when each timer starts, and are compared with the latest block's time.
- **Resolver** (`createResolver`): for each disputed Assertion without an AI Verdict, downloads the Claim and both Evidence items from storage and refuses any whose sha256 doesn't match, gets the exact request bytes from the `ai_request` view, sends them unchanged to NEAR AI Cloud (no streaming, `x-no-aliasing: true`), reads the ed25519 signature (retrying for up to 30 s), checks it against the oracle's Registered Keys and submits `submit_ai_verdict` with 300 TGas. Missing, oversized or mismatched content is logged and the Assertion is left for the AI Verdict deadline to send to Appeal. Each Assertion is handled once; failures (a service down, a rejected transaction) are retried on the next two passes, then given up on. On Cloudflare the attempts are kept in the Durable Object's SQLite storage by oracle and Assertion id, so a restart or deploy doesn't resolve an Assertion twice and a new `ORACLE_ACCOUNT_ID` starts with a clean slate; an Assertion given up on is tried again after 30 minutes (`resolver_retrying`), in case the failure was an outage. The Node process keeps its attempts in memory.
- **Relayers** (`relayOnce`, one per Relayer chain, see below): deliver signed Hooks to their Receivers. A chain whose RPC fails is logged (`relayer_chain_failed`) and doesn't stop the others.

Logs are JSON lines; every NEAR transaction is logged with its NearBlocks link, and every Relayer result with its chain.

## How it runs on Cloudflare

- One Durable Object, `Keeper`, named `keeper`. Only one alarm runs at a time per Durable Object, so this Keeper's passes never overlap. Don't add a second name: it would be a second Keeper with the same keys. For the same reason, don't run the local Node Keeper with the deployed Keeper's NEAR key: both would send transactions from one account.
- Its `alarm()` runs a pass and always sets the next alarm, `POLL_INTERVAL_MS` after the pass started, even when the pass failed (Cloudflare retries a throwing alarm only six times).
- A cron trigger every minute calls `start()`, which sets the alarm if none is set. That starts the loop after the first deploy and restarts it if the alarm is ever lost.
- An alarm may run for up to 15 minutes, and waiting on the network doesn't count as CPU time, so a pass with a 30 s NEAR AI signature wait fits.
- Use the Workers Paid plan. One pass signs transactions and makes dozens of RPC calls, which is more than the Free plan allows per invocation (10 ms of CPU, 50 subrequests).
- There is no public URL (`workersDev: false`). The fetch handler answers 404 and only exists for the dev server.

## Configuration

Settings are checked with Zod when the first pass starts (`src/config.ts`). A bad or missing value fails the pass with the variable's name, never its value, and the alarm tries again a minute later. Empty values count as unset.

| Variable                           | Required     | Kind on Cloudflare | Meaning                                                                                                                        |
| ---------------------------------- | ------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `ORACLE_ACCOUNT_ID`                | yes          | setting            | The oracle contract                                                                                                            |
| `NEAR_ACCOUNT_ID`                  | yes          | setting            | The account that signs and pays for the Keeper's NEAR calls                                                                    |
| `NEAR_PRIVATE_KEY`                 | yes          | secret             | Its key (`ed25519:...`). A function-call key for the oracle is enough                                                          |
| `NEARAI_API_KEY`                   | yes          | secret             | NEAR AI Cloud API key                                                                                                          |
| `STORAGE_URL`                      | yes          | setting            | Storage service, e.g. `https://enzure-storage.luckzivanius.workers.dev`                                                        |
| `NEAR_NETWORK`                     | no           | setting            | `testnet` (default) or `mainnet`                                                                                               |
| `NEAR_RPC_URL`                     | no           | secret             | Another NEAR RPC endpoint                                                                                                      |
| `NEAR_AI_URL`                      | no           | setting            | Defaults to `https://cloud-api.near.ai/v1`                                                                                     |
| `POLL_INTERVAL_MS`                 | no           | setting            | Default 15000, at least 1000                                                                                                   |
| `BASE_RPC_URL`, `BASE_RELAYER_KEY` | no, together | secrets            | Turn the Base Relayer on. The RPC may serve Base (8453) or Base Sepolia (84532); the key (`0x` + 64 hex) pays that chain's gas |

Settings are plain-text bindings, taken from the environment when `cloudflare.config.ts` is evaluated, so `scripts/deploy-keeper.sh` reads them from the root `.env`. Secrets are uploaded with each deploy. RPC URLs are secrets because provider URLs often carry an API key. A deploy doesn't delete secrets uploaded before, so to turn a Relayer chain off, delete its pair, e.g. `npx wrangler secret delete BASE_RELAYER_KEY --name enzure-keeper` and the same for `BASE_RPC_URL`.

## Relayer chains

Each Relayer chain is switched on by a pair of variables, `<CHAIN>_RPC_URL` and `<CHAIN>_RELAYER_KEY`. The chains the Keeper knows are listed in `RELAYER_CHAINS` in `src/chains.ts`, each with the chain ids its RPC may report. At its first use the Keeper asks the RPC for its chain id and refuses an RPC for any other chain. It then delivers only the signed Hooks whose `chain_id` is that id. One Keeper relays to every configured chain; there is no Keeper per chain.

Only Base is implemented now.

### Add a Relayer chain

**Another EVM chain** (Arbitrum, Optimism, ...) needs no new relaying code, because `relayOnce` in core works with any EVM chain:

1. Add an entry to `RELAYER_CHAINS` in `src/chains.ts`, e.g. `ARBITRUM: { kind: "evm", chainIds: [42161, 421614] }`. The name sets the variables: `ARBITRUM_RPC_URL` and `ARBITRUM_RELAYER_KEY`.
2. Add a test case to `tests/config.test.ts` and a row to the table above.
3. Deploy the Receiver to that chain for the oracle's derived EVM address (`scripts/deploy-receiver.sh` with that chain's `EVM_RPC_URL`), and fund the relayer key with that chain's gas. The same key can serve several EVM chains; it then needs gas on each.
4. Set both variables in the root `.env` and run `scripts/deploy-keeper.sh`. It declares and uploads the pair for every `<CHAIN>_RELAYER_KEY` it finds.

**A chain of another kind** (Solana, ...) needs code, because the signed result, its delivery and the key format differ:

1. In the oracle (`contracts/near`): a Hook type for that chain and a signed result it can verify (Solana: an ed25519 signature from Chain Signatures, see ADR 0002 for the EVM design).
2. On the chain: a Receiver program that checks the oracle's signature and records the outcome.
3. In `@enzure/core`: the Hook and signed-result views, a `relayOnce` for that kind with its own clients, and tests next to `tests/relayer.test.ts`.
4. Here: a new `kind` in `RELAYER_CHAINS` (e.g. `SOLANA: { kind: "solana", ... }`), a key format for it in `src/config.ts` (the EVM key regex is per kind), and a branch for the kind in `relayer()` in `src/keeper.ts` that builds its clients and calls its `relayOnce`.

## Develop

From `typescript/`:

```bash
vp install                          # also generates .cloudflare/types with cf workers types
vp test apps/keeper                 # configuration tests; the Resolver, Scheduler and Relayer are tested in core
vp run --filter @enzure/keeper build   # dist/main.mjs (Node) and .cloudflare/output (Worker)
```

Run the Worker locally with `cf dev` in `apps/keeper`. Put secrets in `apps/keeper/.dev.vars` (ignored by git) and settings in the environment, then trigger the cron handler to start the loop:

```bash
cd apps/keeper
ORACLE_ACCOUNT_ID=... NEAR_ACCOUNT_ID=... STORAGE_URL=... vp exec cf dev
curl http://localhost:5173/cdn-cgi/local/scheduled   # from another terminal; passes then follow every POLL_INTERVAL_MS
```

Or run the pass as a Node process with the root `.env`:

```bash
node --env-file=../.env apps/keeper/dist/main.mjs
```

The whole service is checked end to end on testnet by `scripts/keeper-dispute.sh`, which starts the Node process.

## Deploy

```bash
./scripts/deploy-keeper.sh             # from the repository root; --dry-run builds and checks without uploading
```

It reads the variables above and `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` from the environment or the root `.env`, uploads the secrets with the new version, and the cron trigger starts the loop within a minute. Follow the logs with `npx wrangler tail enzure-keeper` or in Workers Logs. The token needs Workers Scripts edit permission.

Not deployed yet. A dry run with placeholder values builds, binds the settings and the Base secrets, and passes `cf deploy`'s checks.

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
