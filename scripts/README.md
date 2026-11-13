# Scripts

Scripts run by hand for testing and operations, such as deploys, DAO setup and checks against live services (ADR 0005).

- `test.sh`: runs the NEAR sandbox tests, the Foundry tests and the Vite+ checks and tests. Run it from anywhere: `./scripts/test.sh`.
- `storage-upload.sh <file>`: uploads a Claim or Evidence file to the storage service and prints its sha256 hash, the value to record on-chain. Status messages go to standard error, so `hash=$(./scripts/storage-upload.sh claim.txt)` works.
- `storage-download.sh <hash> [output]`: downloads content by hash, checks that its sha256 matches, and writes it to `output` or standard output. It writes nothing if the bytes don't match.
- `deploy-storage.sh`: deploys the storage service with Cloudflare credentials from the environment or the root `.env`.

The storage scripts use `STORAGE_URL`, which defaults to the deployed service at `https://enzure-storage.luckzivanius.workers.dev`.
