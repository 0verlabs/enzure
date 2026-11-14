# Run Enzure

Run every command from the repository root.

## Run the tests

```bash
git submodule update --init
./scripts/test.sh
```

It needs Rust (rustup; `contracts/near/rust-toolchain.toml` pins 1.95.0 with `wasm32-unknown-unknown`), Foundry 1.7.1 and Vite+ (`vp`, which downloads Node 26.13.1 and pnpm). Versions are in [`docs/toolchain.md`](toolchain.md). The first run needs network access for crates, forge-std, npm packages and the NEAR sandbox binary, and takes several minutes because the sandbox tests build the contracts to Wasm.

It runs, in order:

- the oracle's Rust unit tests and NEAR sandbox tests (`contracts/near`): the whole lifecycle, every AI Verdict rejection, Appeal and DAO paths, bond splits, NEAR Hook failure and retry, `sign_hook` with a mock Chain Signatures signer, DAO-only methods, upgrade, and the two real fixtures;
- the Foundry tests of the Receiver (`contracts/evm`), the example EVM Consumer (`examples/evm-consumer`) and the escrow (`examples/escrow`), including the real testnet signature delivered through the real Receiver;
- the escrow demo's Claim template tests (`node --test`);
- `vp check` (format, lint, types) and `vp test` in `typescript/`: core, the storage service in the Workers runtime, and the Keeper's config.

You see `==> All tests passed` at the end. The script exits non-zero on the first failure. On 2026-11-13 it ran 52 Rust tests, 37 Foundry tests (18 Receiver, 3 example Consumer, 16 escrow), 3 Claim template tests and 128 Vite+ tests in 16 files, all passing.

## Run the testnet demo

The escrow demo needs keys, so a judge can follow the [recorded runs](deployments.md#recorded-testnet-runs) instead. To run it yourself:

```bash
cd typescript && vp install && vp run --filter @enzure/keeper build && cd ..
./examples/escrow/demo.sh paid        # honest seller: the AI rules TRUE and the escrow pays the seller
./examples/escrow/demo.sh refunded    # the seller writes about cats instead: the AI rules FALSE and the escrow refunds the buyer
```

It reads from the environment or a root `.env` (see [`.env.example`](../.env.example)): `NEAR_ACCOUNT_ID` and `NEAR_PRIVATE_KEY` (a funded testnet account, about 3 NEAR per run, 1.5 of which comes back), `NEARAI_API_KEY`, and `EVM_PRIVATE_KEY` (Base Sepolia ETH and [Circle test USDC](https://faucet.circle.com), or `TEST_USDC=1` to deploy a mintable token). Without them it stops and names the first missing variable. A run takes about 3 minutes: it deploys the Receiver and the escrow, creates the job, starts the Keeper, has the seller agent post the Assertion, disputes it as the buyer, and waits until the Keeper has submitted the AI Verdict, settled, signed the Hook and delivered it. It prints every NEAR and EVM link and the escrow's balances.

To run the EVM side on your machine instead of Base Sepolia, start `anvil --chain-id 84532` and set `EVM_RPC_URL=http://127.0.0.1:8545 EVM_EXPLORER_TX=local: TEST_USDC=1` and anvil's first dev key as `EVM_PRIVATE_KEY`. That is how the recorded runs were made. Details: [`examples/escrow/README.md`](../examples/escrow/README.md).

Other testnet scripts, each documented in [`scripts/README.md`](../scripts/README.md):

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

Connect a NEAR testnet wallet to post (`/assert`), dispute, Appeal and withdraw. Details: [`typescript/apps/web/README.md`](../typescript/apps/web/README.md).

`./scripts/deploy-web.sh` deploys it as the Worker `enzure-web` with Cloudflare credentials; `./scripts/deploy-web.sh mainnet` deploys `enzure-web-mainnet` from `.env.mainnet`. Every deploy script takes `testnet` (the default) or `mainnet` this way ([`scripts/README.md`](../scripts/README.md)).
