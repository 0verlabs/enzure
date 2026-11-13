#!/usr/bin/env bash
# Deploys the Keeper (typescript/apps/keeper) to Cloudflare, with its secrets,
# then starts its alarm loop on the next minute's cron trigger.
#
# Usage: deploy-keeper.sh [testnet|mainnet] [cf deploy options]
# testnet (the default) deploys the Worker `enzure-keeper`; mainnet deploys
# `enzure-keeper-mainnet` (cf deploy --mode <network>, which also sets
# NEAR_NETWORK).
#
# Reads from the environment, or the network's env files for anything unset
# (scripts/lib/env.sh: .env.testnet then .env, or .env.mainnet only):
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   as for scripts/deploy-storage.sh
#   ORACLE_ACCOUNT_ID, NEAR_ACCOUNT_ID, STORAGE_URL                 required settings
#   NEAR_AI_URL, POLL_INTERVAL_MS                                   optional settings
#   NEAR_PRIVATE_KEY, NEARAI_API_KEY                                required secrets
#   NEAR_RPC_URL                                                    optional secret
#   <CHAIN>_RPC_URL and <CHAIN>_RELAYER_KEY, e.g. BASE_RPC_URL and BASE_RELAYER_KEY:
#                                  optional secrets, a pair per Relayer chain
#
# Secrets go to cf in a temporary file readable only by this user, deleted on
# exit; they never appear on a command line. Extra arguments go to `cf deploy`
# (for example --dry-run).
#
# A deploy doesn't delete secrets uploaded before. To turn a Relayer chain
# off, delete its pair: npx wrangler secret delete BASE_RELAYER_KEY --name enzure-keeper
# (and BASE_RPC_URL; --name enzure-keeper-mainnet on mainnet).
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

settings=(ORACLE_ACCOUNT_ID NEAR_ACCOUNT_ID STORAGE_URL NEAR_AI_URL POLL_INTERVAL_MS)
secrets=(NEAR_PRIVATE_KEY NEARAI_API_KEY)
for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID NEAR_NETWORK NEAR_RPC_URL "${settings[@]}" "${secrets[@]}"; do load "$name"; done
# The network comes from the argument; an env file that names another one is a mistake.
if [ -n "${NEAR_NETWORK:-}" ] && [ "$NEAR_NETWORK" != "$network" ]; then
  echo "error: NEAR_NETWORK is $NEAR_NETWORK, but this is a $network deploy" >&2
  exit 1
fi
for name in ORACLE_ACCOUNT_ID NEAR_ACCOUNT_ID STORAGE_URL NEAR_PRIVATE_KEY NEARAI_API_KEY; do
  if [ -z "${!name:-}" ]; then
    echo "error: set $name in the environment or ${env_files[0]}" >&2
    exit 1
  fi
done
# Settings left empty are unset, so the Keeper's defaults apply.
for name in "${settings[@]}" NEAR_RPC_URL; do
  if [ -z "${!name:-}" ]; then unset "$name"; fi
done
if [ -n "${NEAR_RPC_URL:-}" ]; then secrets+=(NEAR_RPC_URL); fi

# Relayer chains: every <CHAIN>_RELAYER_KEY in the environment or the network's env files, with its <CHAIN>_RPC_URL.
chains="$( {
  env
  env_file_contents
} | sed -n 's/^\([A-Z][A-Z0-9]*\)_RELAYER_KEY=..*/\1/p' | sort -u)"
relayers=()
for chain in $chains; do
  load "${chain}_RELAYER_KEY"
  load "${chain}_RPC_URL"
  rpc="${chain}_RPC_URL"
  if [ -z "${!rpc:-}" ]; then
    echo "error: ${chain}_RELAYER_KEY is set but ${chain}_RPC_URL isn't; set both or neither" >&2
    exit 1
  fi
  secrets+=("${chain}_RPC_URL" "${chain}_RELAYER_KEY")
  relayers+=("$chain")
done
echo "Relayer chains: ${relayers[*]:-none}" >&2
echo "Deploying the Keeper to $network" >&2

secrets_file="$(mktemp)"
chmod 600 "$secrets_file"
trap 'rm -f "$secrets_file"' EXIT
# Values are read from the environment inside node, so they never reach argv.
SECRET_NAMES="${secrets[*]}" node -e '
  const names = process.env.SECRET_NAMES.split(" ");
  require("fs").writeFileSync(process.argv[1], JSON.stringify(Object.fromEntries(names.map((n) => [n, process.env[n]]))));
' "$secrets_file"

cd "$root/typescript"
vp install --frozen-lockfile
cd apps/keeper
# cloudflare.config.ts reads the settings, and which Relayer chains to declare, from this environment.
vp exec cf deploy --mode "$network" --secrets-file "$secrets_file" "$@"
