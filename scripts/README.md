# Scripts

Scripts run by hand for testing and operations, such as deploys, DAO setup and checks against live services (ADR 0005).

- `test.sh`: runs the NEAR sandbox tests, the Foundry tests and the Vite+ checks and tests. Run it from anywhere: `./scripts/test.sh`.
- `storage-upload.sh <file>`: uploads a Claim or Evidence file to the storage service and prints its sha256 hash, the value to record on-chain. Status messages go to standard error, so `hash=$(./scripts/storage-upload.sh claim.txt)` works.
- `storage-download.sh <hash> [output]`: downloads content by hash, checks that its sha256 matches, and writes it to `output` or standard output. It writes nothing if the bytes don't match.
- `deploy-storage.sh`: deploys the storage service with Cloudflare credentials from the environment or the root `.env`.
- `oracle-undisputed.sh`: runs the undisputed path on NEAR testnet. It builds the oracle, deploys it to a new development account `oracle-<timestamp>.<NEAR_ACCOUNT_ID>`, posts an Assertion with a 60-second Liveness, settles it once Liveness ends, withdraws the bond, and prints a NearBlocks link for each transaction. It takes `NEAR_ACCOUNT_ID` and `NEAR_PRIVATE_KEY` from the environment or the root `.env`, and needs about 3.1 testnet NEAR: 2 NEAR stays on the development account (delete it to recover it) and the 1 NEAR bond comes back. Optional: `ORACLE_DAO_ACCOUNT_ID`, `LIVENESS_SECS`, `BOND_YOCTO`, `ORACLE_BALANCE`.

The storage scripts use `STORAGE_URL`, which defaults to the deployed service at `https://enzure-storage.luckzivanius.workers.dev`.

The NEAR scripts write the private key to an access-key file in a temporary folder only they can read, and delete it on exit, so the key never appears in a command line.
