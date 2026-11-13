#!/usr/bin/env bash
# Deletes every full-access key on the oracle account, then checks that none
# remain (ADR 0004). Afterwards the only way to change the oracle's code is a
# DAO proposal calling its `upgrade` method.
#
#   scripts/oracle-lockdown.sh <oracle-account-id>                # delete the keys, then verify
#   scripts/oracle-lockdown.sh <oracle-account-id> --verify-only  # only verify; needs no keys
#
# It acts only on the account named on the command line: every key it deletes
# is read from that account, and the transaction is signed as and sent to that
# account. It refuses to run unless that account holds an Enzure oracle whose
# DAO is a Sputnik DAO (so the DAO can still upgrade it), and, when
# NEAR_ACCOUNT_ID is set, unless it equals the named account. Deleting keys
# can't be undone.
#
# Needs near (near-cli-rs) and node, and in the environment:
#   NEAR_PRIVATE_KEY   a full-access key of the oracle account (ed25519:...)
# Optional: NEAR_ACCOUNT_ID (must equal the named account), NEAR_RPC_URL
# (https://rpc.testnet.near.org).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/near.sh
source "$root/scripts/lib/near.sh"
# shellcheck source=scripts/lib/dao.sh
source "$root/scripts/lib/dao.sh"

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || { sed -n '6,7p' "$0" | sed 's/^# //' >&2; exit 2; }
oracle="$1"
verify_only=""
case "${2:-}" in
  "") ;;
  --verify-only) verify_only=1 ;;
  *) die "unknown option $2" ;;
esac
rpc="${NEAR_RPC_URL:-https://rpc.testnet.near.org}"
require_tools near node

# Prints the account's full-access public keys, one per line.
full_access_keys() {
  node --input-type=module -e '
    const [rpc, account] = process.argv.slice(1);
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query",
        params: { request_type: "view_access_key_list", finality: "final", account_id: account } }),
    });
    const { result, error } = await response.json();
    if (error || !result?.keys) { console.error(JSON.stringify(error ?? result)); process.exit(1); }
    for (const { public_key, access_key } of result.keys) {
      if (access_key.permission === "FullAccess") console.log(public_key);
    }' "$rpc" "$oracle"
}

verify() {
  local keys
  keys="$(full_access_keys)" || die "could not read the access keys of $oracle"
  if [ -n "$keys" ]; then
    printf 'FAILED: %s still has full-access keys:\n%s\n' "$oracle" "$keys" >&2
    return 1
  fi
  echo "OK: $oracle has no full-access keys. Only its DAO can change its code, through upgrade." >&2
}

step "Checking that $oracle is an Enzure oracle governed by a Sputnik DAO"
config="$(view_on "$oracle" get_config '{}')" || die "$oracle has no Enzure oracle (no get_config view); refusing"
dao="$(json_field dao <<<"$config")"
require_sputnik_dao "$dao"
echo "Oracle $oracle, DAO $dao" >&2

if [ -n "$verify_only" ]; then
  verify
  exit
fi

if [ -n "${NEAR_ACCOUNT_ID:-}" ] && [ "$NEAR_ACCOUNT_ID" != "$oracle" ]; then
  die "NEAR_ACCOUNT_ID is $NEAR_ACCOUNT_ID, not $oracle; refusing to touch another account"
fi
: "${NEAR_PRIVATE_KEY:?Set NEAR_PRIVATE_KEY to a full-access key of $oracle}"
export NEAR_PRIVATE_KEY
near_keys_init

keys="$(full_access_keys)" || die "could not read the access keys of $oracle"
if [ -z "$keys" ]; then
  verify
  exit
fi
grep -qxF "$NEAR_PUBLIC_KEY" <<<"$keys" ||
  die "NEAR_PRIVATE_KEY's public key $NEAR_PUBLIC_KEY is not a full-access key of $oracle"

step "Deleting every full-access key of $oracle"
printf '  %s\n' $keys >&2
# One transaction, signed by one of the keys it deletes.
send "delete full-access keys" account delete-keys "$oracle" public-keys "$(paste -sd, - <<<"$keys")" \
  network-config "$NEAR_NETWORK" sign-with-access-key-file "$(near_key_file "$oracle")" send

step "Verifying"
# The view reads final blocks, a few seconds behind the transaction.
for _ in 1 2 3 4 5; do
  [ -z "$(full_access_keys)" ] && break
  sleep 3
done
verify
print_links
