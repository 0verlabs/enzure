#!/usr/bin/env bash
# Deploys the storage service (typescript/apps/storage) to Cloudflare.
#
# Usage: deploy-storage.sh [testnet|mainnet] [cf deploy options]
# testnet (the default) deploys the Worker `enzure-storage` with the R2 bucket
# `enzure-content`; mainnet deploys `enzure-storage-mainnet` with
# `enzure-content-mainnet` (cf deploy --mode <network>).
#
# Credentials come from the environment: CLOUDFLARE_API_TOKEN and, if the
# token can reach more than one account, CLOUDFLARE_ACCOUNT_ID. Values in the
# network's env files are used when they aren't already set (scripts/lib/env.sh:
# .env.testnet then .env, or .env.mainnet then .env). Without a token, cf falls
# back to a `cf auth login` session. Extra arguments go to `cf deploy` (for
# example --dry-run).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

network=testnet
case "${1:-}" in
  testnet | mainnet)
    network="$1"
    shift
    ;;
esac
# shellcheck source=scripts/lib/env.sh
source "$root/scripts/lib/env.sh"

for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do load "$name"; done

echo "Deploying the storage service to $network" >&2
cd "$root/typescript"
vp install --frozen-lockfile
cd apps/storage
vp exec cf deploy --mode "$network" "$@"
