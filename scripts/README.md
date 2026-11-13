# Scripts

Scripts run by hand for testing and operations, such as deploys, DAO setup and checks against live services (ADR 0005).

- `test.sh`: runs the NEAR sandbox tests, the Foundry tests and the Vite+ checks and tests. Run it from anywhere: `./scripts/test.sh`.
- `check-near-ai-signing.mts`: sends one AI Verdict request to NEAR AI Cloud and checks that the response carries a `provider_tee` ed25519 signature over the exact request and response bytes, from the key in the model's attestation report. It needs `NEARAI_API_KEY` and costs well under $0.001 per run. Run it from the repository root:

  ```bash
  node --env-file-if-exists=.env scripts/check-near-ai-signing.mts                  # check Prompt Template v1's model
  node --env-file-if-exists=.env scripts/check-near-ai-signing.mts --model <id>     # try another model with the same settings
  node --env-file-if-exists=.env scripts/check-near-ai-signing.mts --write-fixture  # also replace fixtures/near-ai-cloud/signed-response.json
  ```

  It exits non-zero if any check fails. Results are in `docs/research/near-ai-cloud.md` §7.
- `storage-upload.sh <file>`: uploads a Claim or Evidence file to the storage service and prints its sha256 hash, the value to record on-chain. Status messages go to standard error, so `hash=$(./scripts/storage-upload.sh claim.txt)` works.
- `storage-download.sh <hash> [output]`: downloads content by hash, checks that its sha256 matches, and writes it to `output` or standard output. It writes nothing if the bytes don't match.
- `deploy-storage.sh`: deploys the storage service with Cloudflare credentials from the environment or the root `.env`.
- `oracle-undisputed.sh`: runs the undisputed path on NEAR testnet. It builds the oracle, deploys it to a new development account `oracle-<timestamp>.<NEAR_ACCOUNT_ID>`, posts an Assertion with a 60-second Liveness, settles it once Liveness ends, withdraws the bond, and prints a NearBlocks link for each transaction. It takes `NEAR_ACCOUNT_ID` and `NEAR_PRIVATE_KEY` from the environment or the root `.env`, and needs about 3.1 testnet NEAR: 2 NEAR stays on the development account (delete it to recover it) and the 1 NEAR bond comes back. Optional: `ORACLE_DAO_ACCOUNT_ID`, `LIVENESS_SECS`, `BOND_YOCTO`, `ORACLE_BALANCE`.
- `oracle-evm-hook.sh [--write-fixture]`: signs one EVM Hook through Chain Signatures on NEAR testnet. Like `oracle-undisputed.sh`, it deploys the oracle to a new development account, then posts an Assertion with one EVM Hook, settles it, calls `sign_hook` on `v1.signer-prod.testnet`, prints the signed result and the oracle's derived EVM address, and withdraws the bond. `--write-fixture` replaces `fixtures/chain-signatures/signed-result.json`. Same credentials as `oracle-undisputed.sh`; about 4.1 testnet NEAR, of which 3 NEAR stays on the development account. Optional: `ORACLE_ACCOUNT_ID` (reuse a deployed oracle instead of deploying one; then it needs only the bond and fees), `EVM_SIGNER`, `EVM_CHAIN_ID`, `EVM_RECEIVER`, `EVM_CONSUMER`, `SIGN_DEPOSIT`, `LIVENESS_SECS`, `BOND_YOCTO`, `ORACLE_BALANCE`, `ORACLE_DAO_ACCOUNT_ID`.
- `deploy-receiver.sh <oracle-account-id> [--with-example-consumer]`: deploys the Receiver for that oracle to Base Sepolia and records it in `contracts/evm/deployments/<chain id>.json`. It reads the oracle's derived EVM address with `oracle-evm-address.mts` (or takes `ORACLE_EVM_ADDRESS`) and runs `contracts/evm/script/DeployReceiver.s.sol`. `--with-example-consumer` also deploys `examples/evm-consumer` for the new Receiver. It needs `EVM_PRIVATE_KEY`, a deployer key with Base Sepolia ETH, from the environment or the root `.env`; optional `EVM_RPC_URL` (`https://sepolia.base.org`) and `NEAR_RPC_URL`. The key reaches forge through the environment, never the command line.
- `relay-evm-hooks.mts <oracle-account-id>`: one Relayer pass. It reads the oracle's Assertions and delivers every signed EVM Hook for the chain at `EVM_RPC_URL` to its Receiver, skipping results already recorded, and prints a Basescan link per delivery. The Keeper runs the same core function, `relayOnce`, in a loop. Needs `EVM_PRIVATE_KEY` (pays the gas): `node --env-file-if-exists=.env scripts/relay-evm-hooks.mts <oracle-account-id>`.
- `oracle-evm-address.mts <oracle-account-id> [--rpc <url>]`: prints the EVM address a deployed oracle signs EVM Hooks with. It reads the signer, path and domain from the oracle's `get_evm_signer` view and asks the signer for `derived_public_key`. Needs no credentials: `node scripts/oracle-evm-address.mts oracle.testnet`.

### EVM Hook end to end on testnet

1. `./scripts/oracle-evm-hook.sh` deploys a development oracle (its first Hook goes to placeholder addresses) and prints the oracle account.
2. `./scripts/deploy-receiver.sh <oracle> --with-example-consumer` deploys a Receiver for that oracle's derived address and the example Consumer.
3. `ORACLE_ACCOUNT_ID=<oracle> EVM_RECEIVER=<receiver> EVM_CONSUMER=<consumer> ./scripts/oracle-evm-hook.sh` posts, settles and signs an Assertion with a Hook to them.
4. `node --env-file-if-exists=.env scripts/relay-evm-hooks.mts <oracle>` delivers it; `cast call <consumer> "results(uint256)(bool,bool,bytes32,bytes32)" <assertion id> --rpc-url https://sepolia.base.org` shows the recorded outcome.

The storage scripts use `STORAGE_URL`, which defaults to the deployed service at `https://enzure-storage.luckzivanius.workers.dev`.

The NEAR scripts write the private key to an access-key file in a temporary folder only they can read, and delete it on exit, so the key never appears in a command line.
