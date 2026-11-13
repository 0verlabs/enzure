# @enzure/web

The Enzure web app: TanStack Start with Tailwind and shadcn/ui on Base UI (`base-nova`, dark theme only), on a Cloudflare Worker. Anyone with a NEAR testnet wallet can post an Assertion, dispute one during Liveness, Appeal a lost AI Verdict, follow its timeline through Appeal and Hook delivery, retry or sign Hooks, and withdraw their balance.

## Pages

| Path                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                        | Recent Assertions from the contract's `list_assertions` view, 20 per page (`?before=<id>` for older ones), filterable by state. The sidebar shows the connected account's withdrawable balance and a Withdraw button (`withdraw`, 1 yoctoNEAR) on every page.                                                                                                                                                                                                         |
| `/assert`                  | Post an Assertion: type or load a Claim and optional Evidence, choose bond and Liveness (a preset or a custom 1 minute to 7 days). The app uploads both to the storage service, puts their sha256 hashes in `assert_claim` and attaches bond + `assertion_storage_deposit`.                                                                                                                                                                                           |
| `/assertions/:id`          | State, Liveness countdown, dispute form (bond + `dispute_storage_deposit`) while Liveness runs, the timeline with a NEAR transaction link per step, and the Claim and both Evidence items from storage, marked as matching their hash or not.                                                                                                                                                                                                                         |
| `/assertions/:id` (Appeal) | To the party that lost the AI Verdict (`canAppeal`), during the Appeal Window: an Appeal button (`appeal`, deposit = the Assertion's bond). In Appeal: the reason (appealed, Conflicting Verdicts, UNRESOLVABLE, no verdict) and the DAO deadline. Timeline: the move to Appeal, the DAO's deadline or ruling, with the Sputnik proposal and the transaction that created it.                                                                                         |
| `/assertions/:id` (Hooks)  | After settlement, one timeline step per Hook. NEAR Hooks: delivered / failed / delivering, with a Retry button for failed ones (`retry_near_hook`, 300 TGas). EVM Hooks: unsigned / signing / signed / delivered, a Start signing button for unsigned ones (`sign_hook`, 1 yoctoNEAR, 300 TGas), the signed result (`get_signed_result`), the NEAR signing transaction, and the Receiver's `isDelivered` / `outcomeOf` on Base Sepolia with the delivery transaction. |

How it reads:

- Contract state only through view methods over NEAR JSON-RPC (`nearRpcView` in `@enzure/core`). There is no indexer, D1 or Drizzle.
- Transaction links: the contract doesn't store transaction hashes, so the browser asks the public FastNEAR transactions API (`tx.test.fastnear.com`) for the oracle's transactions since the Assertion was posted and matches the oracle's `enzure` events by `assertion_id` (`fetchAssertionEvents`, `timelineTransactions`). Only logs from receipts the oracle executed count. If that API is down, the timeline still shows, without links.
- Claim and Evidence are fetched and hash-checked in the browser (`fetchContent`).

- The DAO's ruling: the `appeal_resolved` event's transaction is the DAO's `act_proposal`; its `id` is the proposal (`daoProposalId`). The proposal's creation is the DAO's `add_proposal` transaction that returned that id (`fetchProposalTransaction`, FastNEAR again).
- EVM Hooks: `isDelivered` and `outcomeOf` over Base Sepolia JSON-RPC, and the delivery transaction from the `OutcomeRecorded` log through Blockscout's keyless logs API, because the public RPC limits `eth_getLogs` to 200 blocks (`fetchEvmDelivery`). Only Base Sepolia (chain 84532) is read; Hooks for other chains show their status from NEAR only.

The timeline's steps come from core's `assertionTimeline`; `src/components/timeline.tsx` maps each step kind to how it is shown.

## Configuration

Fixed at build time from the environment or the repository's root env files (only these values reach the bundle). The build's mode picks the network: `--mode mainnet` reads `.env.mainnet` only and builds the Worker `enzure-web-mainnet`; every other mode is testnet, reads `.env` and `.env.testnet` (which wins), and builds `enzure-web`. `NEAR_NETWORK` comes from the mode, and a build stops if the environment names the other network.

| Variable            | Required | Default                                   |
| ------------------- | -------- | ----------------------------------------- |
| `ORACLE_ACCOUNT_ID` | yes      |                                           |
| `STORAGE_URL`       | yes      |                                           |
| `NEAR_NETWORK`      | no       | from the mode: `testnet` or `mainnet`     |
| `NEAR_RPC_URL`      | no       | `https://test.rpc.fastnear.com`           |
| `NEAR_TX_API_URL`   | no       | `https://tx.test.fastnear.com`            |
| `NEAR_EXPLORER_URL` | no       | `https://testnet.nearblocks.io`           |
| `EVM_RPC_URL`       | no       | `https://sepolia.base.org`                |
| `EVM_LOGS_API_URL`  | no       | `https://base-sepolia.blockscout.com/api` |
| `EVM_EXPLORER_URL`  | no       | `https://sepolia.basescan.org`            |

A build without the required values still works but shows an alert naming what is missing.

## Develop

```bash
cd typescript && vp install
cd apps/web
ORACLE_ACCOUNT_ID=<oracle>.testnet vp exec cf dev   # http://localhost:3000; STORAGE_URL comes from the root .env
```

The storage service's CORS list (`apps/storage/cloudflare.config.ts`) allows `http://localhost:3000`, `http://localhost:5173` and the web app's Worker on the same network: `https://enzure-web.luckzivanius.workers.dev` on testnet, `https://enzure-web-mainnet.luckzivanius.workers.dev` on mainnet. Deploying under another name needs that list updated.

## Deploy

```bash
./scripts/deploy-web.sh           # from the repository root; testnet, as enzure-web
./scripts/deploy-web.sh mainnet   # mainnet, as enzure-web-mainnet, from .env.mainnet
```

Both need `ORACLE_ACCOUNT_ID` and `STORAGE_URL`. `cf` doesn't pass `--mode` to `vp build`, so the script runs `vp build --mode <network>` and then `cf deploy --prebuilt --mode <network>`; `vp run deploy:testnet` and `vp run deploy:mainnet` in this folder do the same. The EVM settings still default to Base Sepolia on mainnet; set the `EVM_*` variables for another chain.

It uses `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` like `deploy-storage.sh`, or a `cf auth login` session.
