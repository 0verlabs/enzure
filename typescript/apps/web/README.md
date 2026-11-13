# @enzure/web

The Enzure web app: TanStack Start with Tailwind and shadcn/ui, on a Cloudflare Worker. Anyone with a NEAR testnet wallet can post an Assertion, dispute one during Liveness, follow its timeline and withdraw their balance.

## Pages

| Path              | What it does                                                                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`               | Recent Assertions from the contract's `list_assertions` view, 20 per page (`?before=<id>` for older ones). With a wallet connected, the account's withdrawable balance and a Withdraw button (`withdraw`, 1 yoctoNEAR).                       |
| `/assert`         | Post an Assertion: type or load a Claim and optional Evidence, choose bond and Liveness. The app uploads both to the storage service, puts their sha256 hashes in `assert_claim` and attaches bond + `assertion_storage_deposit`.             |
| `/assertions/:id` | State, Liveness countdown, dispute form (bond + `dispute_storage_deposit`) while Liveness runs, the timeline with a NEAR transaction link per step, and the Claim and both Evidence items from storage, marked as matching their hash or not. |

How it reads:

- Contract state only through view methods over NEAR JSON-RPC (`nearRpcView` in `@enzure/core`). There is no indexer, D1 or Drizzle.
- Transaction links: the contract doesn't store transaction hashes, so the browser asks the public FastNEAR transactions API (`tx.test.fastnear.com`) for the oracle's transactions since the Assertion was posted and matches the oracle's `enzure` events by `assertion_id` (`fetchAssertionEvents`, `timelineTransactions`). Only logs from receipts the oracle executed count. If that API is down, the timeline still shows, without links.
- Claim and Evidence are fetched and hash-checked in the browser (`fetchContent`).

The timeline's steps come from core's `assertionTimeline`; `src/components/timeline.tsx` maps each step kind to how it is shown. Appeal steps and Hook deliveries (ticket #14) are added as new step kinds there.

## Configuration

Fixed at build time from the environment or the repository's root `.env` (only these values reach the bundle):

| Variable            | Required | Default                         |
| ------------------- | -------- | ------------------------------- |
| `ORACLE_ACCOUNT_ID` | yes      |                                 |
| `STORAGE_URL`       | yes      |                                 |
| `NEAR_NETWORK`      | no       | `testnet`                       |
| `NEAR_RPC_URL`      | no       | `https://test.rpc.fastnear.com` |
| `NEAR_TX_API_URL`   | no       | `https://tx.test.fastnear.com`  |
| `NEAR_EXPLORER_URL` | no       | `https://testnet.nearblocks.io` |

A build without the required values still works but shows an alert naming what is missing.

## Develop

```bash
cd typescript && vp install
cd apps/web
ORACLE_ACCOUNT_ID=<oracle>.testnet vp exec cf dev   # http://localhost:3000; STORAGE_URL comes from the root .env
```

The storage service's CORS list (`apps/storage/cloudflare.config.ts`) allows `http://localhost:3000` and `https://enzure-web.luckzivanius.workers.dev`. Deploying under another name needs that list updated.

## Deploy

```bash
./scripts/deploy-web.sh   # from the repository root; needs ORACLE_ACCOUNT_ID and STORAGE_URL
```

It uses `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` like `deploy-storage.sh`, or a `cf auth login` session.
