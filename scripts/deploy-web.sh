#!/usr/bin/env bash
# Builds and deploys the web app (typescript/apps/web) to Cloudflare.
#
# Usage: deploy-web.sh [testnet|mainnet] [cf deploy options]
# testnet (the default) deploys the Worker `enzure-web`; mainnet deploys
# `enzure-web-mainnet` (cf deploy --mode <network>).
#
# The app's configuration is fixed at build time: ORACLE_ACCOUNT_ID and
# STORAGE_URL are required; NEAR_RPC_URL, NEAR_TX_API_URL and
# NEAR_EXPLORER_URL are optional. NEAR_NETWORK comes from the network chosen
# here. Credentials: CLOUDFLARE_API_TOKEN and, if the token reaches more than
# one account, CLOUDFLARE_ACCOUNT_ID; without a token, cf uses a
# `cf auth login` session. Values in the network's env files are used when
# they aren't already set (scripts/lib/env.sh: .env.testnet then .env, or
# .env.mainnet only). Extra arguments go to `cf deploy` (for example --dry-run).
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

for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID ORACLE_ACCOUNT_ID STORAGE_URL; do load "$name"; done

for name in ORACLE_ACCOUNT_ID STORAGE_URL; do
  if [ -z "${!name:-}" ]; then
    echo "Set $name (in the environment or ${env_files[0]}) before deploying the web app to $network." >&2
    exit 1
  fi
done

echo "Deploying the web app to $network" >&2
cd "$root/typescript"
vp install --frozen-lockfile
cd apps/web
# cf doesn't pass --mode to the app's `vp build`, so build here and deploy that
# Build Output. vite.config.ts reads the optional settings from the same env files.
vp build --mode "$network"
vp exec cf deploy --prebuilt --mode "$network" "$@"
