#!/usr/bin/env bash
# Builds and deploys the web app (typescript/apps/web) to Cloudflare as the
# Worker `enzure-web`.
#
# The app's configuration is fixed at build time: ORACLE_ACCOUNT_ID and
# STORAGE_URL are required; NEAR_NETWORK (default testnet), NEAR_RPC_URL,
# NEAR_TX_API_URL and NEAR_EXPLORER_URL are optional. Credentials:
# CLOUDFLARE_API_TOKEN and, if the token reaches more than one account,
# CLOUDFLARE_ACCOUNT_ID; without a token, cf uses a `cf auth login` session.
# Values in the repository's .env are used when they aren't already set.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$root/.env" ]; then
  for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID ORACLE_ACCOUNT_ID STORAGE_URL NEAR_NETWORK; do
    if [ -z "${!name:-}" ]; then
      value="$(sed -n "s/^${name}=//p" "$root/.env" | tail -n 1)"
      if [ -n "$value" ]; then
        export "$name=$value"
      fi
    fi
  done
fi

for name in ORACLE_ACCOUNT_ID STORAGE_URL; do
  if [ -z "${!name:-}" ]; then
    echo "Set $name (in the environment or $root/.env) before deploying the web app." >&2
    exit 1
  fi
done

cd "$root/typescript"
vp install --frozen-lockfile
cd apps/web
vp exec cf deploy "$@"
