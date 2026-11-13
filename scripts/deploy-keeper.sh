#!/usr/bin/env bash
# Deploys the Keeper (typescript/apps/keeper) to Cloudflare as the Worker
# `enzure-keeper`, with its secrets, then starts its alarm loop on the next
# minute's cron trigger.
#
# Reads from the environment, or the repository's .env for anything unset:
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   as for scripts/deploy-storage.sh
#   ORACLE_ACCOUNT_ID, NEAR_ACCOUNT_ID, STORAGE_URL                 required settings
#   NEAR_NETWORK, NEAR_RPC_URL, NEAR_AI_URL, POLL_INTERVAL_MS       optional settings
#   NEAR_PRIVATE_KEY, NEARAI_API_KEY                                required secrets
#   <CHAIN>_RPC_URL and <CHAIN>_RELAYER_KEY, e.g. BASE_RPC_URL and BASE_RELAYER_KEY:
#                                  optional secrets, a pair per Relayer chain
#
# Secrets go to cf in a temporary file readable only by this user, deleted on
# exit; they never appear on a command line. Extra arguments go to `cf deploy`
# (for example --dry-run).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Sets $1 from the root .env when it isn't already set.
load() {
  local name="$1" value
  if [ -z "${!name:-}" ] && [ -f "$root/.env" ]; then
    value="$(sed -n "s/^${name}=//p" "$root/.env" | tail -n 1)"
    if [ -n "$value" ]; then export "$name=$value"; fi
  fi
  return 0
}

settings=(ORACLE_ACCOUNT_ID NEAR_ACCOUNT_ID STORAGE_URL NEAR_NETWORK NEAR_RPC_URL NEAR_AI_URL POLL_INTERVAL_MS)
secrets=(NEAR_PRIVATE_KEY NEARAI_API_KEY)
for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID "${settings[@]}" "${secrets[@]}"; do load "$name"; done
for name in ORACLE_ACCOUNT_ID NEAR_ACCOUNT_ID STORAGE_URL NEAR_PRIVATE_KEY NEARAI_API_KEY; do
  if [ -z "${!name:-}" ]; then
    echo "error: set $name in the environment or the root .env" >&2
    exit 1
  fi
done
# Settings left empty are unset, so the Keeper's defaults apply.
for name in "${settings[@]}"; do
  if [ -z "${!name:-}" ]; then unset "$name"; fi
done

# Relayer chains: every <CHAIN>_RELAYER_KEY in the environment or .env, with its <CHAIN>_RPC_URL.
chains="$( { env; [ -f "$root/.env" ] && cat "$root/.env"; } | sed -n 's/^\([A-Z][A-Z0-9]*\)_RELAYER_KEY=..*/\1/p' | sort -u)"
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
vp exec cf deploy --secrets-file "$secrets_file" "$@"
