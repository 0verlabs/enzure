#!/usr/bin/env bash
# Runs the undisputed path through the oracle on NEAR testnet: deploys the
# contract to a fresh development account, posts an Assertion with a short
# Liveness, waits for it to end, settles the Assertion and withdraws the bond.
# Prints a NearBlocks link for every transaction.
#
# Needs near (near-cli-rs), cargo-near and node (see docs/toolchain.md), and a
# funded testnet account in the environment or the repository's .env:
#   NEAR_ACCOUNT_ID    the Asserter, and parent of the development account
#   NEAR_PRIVATE_KEY   a full-access key of NEAR_ACCOUNT_ID (ed25519:...)
# Optional:
#   ORACLE_DAO_ACCOUNT_ID  DAO the oracle is initialised with (NEAR_ACCOUNT_ID)
#   LIVENESS_SECS          Liveness of the Assertion, 60 to 604800 (60)
#   BOND_YOCTO             bond in yoctoNEAR (1 NEAR)
#   ORACLE_BALANCE         NEAR given to the development account ("2 NEAR")
#
# The development account is <name>.<NEAR_ACCOUNT_ID> and has the same key, so
# it can be deleted afterwards to recover its balance.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/near.sh
source "$root/scripts/lib/near.sh"
# shellcheck source=scripts/lib/storage.sh
source "$root/scripts/lib/storage.sh"

load_env "$root" NEAR_ACCOUNT_ID NEAR_PRIVATE_KEY ORACLE_DAO_ACCOUNT_ID
for tool in near cargo node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' not found, see docs/toolchain.md (node comes with Vite+)" >&2; exit 1; }
done
: "${NEAR_ACCOUNT_ID:?Set NEAR_ACCOUNT_ID to a funded testnet account}"
: "${NEAR_PRIVATE_KEY:?Set NEAR_PRIVATE_KEY to a full-access key of NEAR_ACCOUNT_ID}"
export NEAR_PRIVATE_KEY
dao="${ORACLE_DAO_ACCOUNT_ID:-$NEAR_ACCOUNT_ID}"
liveness="${LIVENESS_SECS:-60}"
bond="${BOND_YOCTO:-1000000000000000000000000}"
oracle_balance="${ORACLE_BALANCE:-2 NEAR}"
oracle="oracle-$(date +%s).$NEAR_ACCOUNT_ID"

near_keys_init
asserter_key="$(near_key_file "$NEAR_ACCOUNT_ID")"
oracle_key="$(near_key_file "$oracle")"

step() { printf '\n==> %s\n' "$1" >&2; }

# Runs a near CLI command that sends a transaction and records a link to it.
# Prints the CLI's output only if the command fails or prints no transaction hash.
send() {
  local label="$1" output hash
  shift
  if ! output="$(near "$@" 2>&1)"; then
    printf '%s\n' "$output" >&2
    return 1
  fi
  hash="$(tx_hash_of "$output")"
  if [ -z "$hash" ]; then
    printf '%s\nerror: no transaction hash in the output above\n' "$output" >&2
    return 1
  fi
  links+=("$label: $NEAR_EXPLORER/$hash")
  echo "Transaction: $NEAR_EXPLORER/$hash" >&2
  last_output="$output"
}

# Prints the return value of the last function call `send` made.
last_return_value() {
  sed -n '/Function execution return value/{n;p;q;}' <<<"$last_output"
}

# Calls an oracle view method and prints its JSON result.
view() {
  near --quiet contract call-function as-read-only "$oracle" "$1" json-args "$2" \
    network-config "$NEAR_NETWORK" now 2>/dev/null
}

# Calls an oracle method as the Asserter.
call() {
  send "$1" contract call-function as-transaction "$oracle" "$1" json-args "$2" \
    prepaid-gas '100 Tgas' attached-deposit "$3" sign-as "$NEAR_ACCOUNT_ID" \
    network-config "$NEAR_NETWORK" sign-with-access-key-file "$asserter_key" send
}

# Prints one field of the JSON object on standard input.
json_field() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let value = JSON.parse(s);
      const path = process.argv[1] === "." ? [] : process.argv[1].split(".");
      for (const key of path) value = value[key];
      console.log(typeof value === "object" ? JSON.stringify(value) : String(value));
    });' "$1"
}

links=()
last_output=""

step "Building the oracle"
(cd "$root/contracts/near/oracle" && cargo near build non-reproducible-wasm --locked >&2)
wasm="$root/contracts/near/target/near/oracle/oracle.wasm"

step "Creating the development account $oracle"
send "create development account" account create-account fund-myself "$oracle" "$oracle_balance" \
  use-manually-provided-public-key "$NEAR_PUBLIC_KEY" sign-as "$NEAR_ACCOUNT_ID" \
  network-config "$NEAR_NETWORK" sign-with-access-key-file "$asserter_key" send

step "Deploying the oracle with $dao as its DAO"
send "deploy" contract deploy "$oracle" use-file "$wasm" with-init-call new json-args "{\"dao\":\"$dao\"}" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config "$NEAR_NETWORK" \
  sign-with-access-key-file "$oracle_key" send

step "Posting an Assertion with a ${liveness}-second Liveness"
claim="Enzure testnet run on $(date -u +%Y-%m-%dT%H:%M:%SZ): this Assertion goes undisputed."
printf '%s' "$claim" >"$NEAR_KEYS_DIR/claim.txt"
claim_hash="$(sha256_of "$NEAR_KEYS_DIR/claim.txt")"
storage="$(view assertion_storage_deposit '{}' | json_field .)"
deposit="$(yocto_add "$bond" "$storage")"
call assert_claim \
  "{\"claim_hash\":\"$claim_hash\",\"bond\":\"$bond\",\"liveness\":$liveness,\"hooks\":[]}" \
  "$deposit yoctoNEAR"
assertion_id="$(last_return_value)"
case "$assertion_id" in
  '' | *[!0-9]*) echo "error: assert_claim returned '$assertion_id', not an Assertion id" >&2; exit 1 ;;
esac
echo "Assertion $assertion_id, Claim: $claim" >&2

ends_ns="$(view get_assertion "{\"assertion_id\":$assertion_id}" | json_field liveness_ends_at_ns)"
wait_secs=$(( ends_ns / 1000000000 - $(date +%s) + 2 ))
if [ "$wait_secs" -gt 0 ]; then
  step "Waiting ${wait_secs}s for Liveness to end"
  sleep "$wait_secs"
fi

step "Settling Assertion $assertion_id"
# The chain's clock can trail this machine's by a few seconds, so retry briefly.
for attempt in 1 2 3 4 5 6; do
  if call settle "{\"assertion_id\":$assertion_id}" '0 NEAR'; then
    break
  fi
  [ "$attempt" -lt 6 ] || exit 1
  sleep 5
done

step "Withdrawing the bond"
balance="$(view get_balance "{\"account_id\":\"$NEAR_ACCOUNT_ID\"}" | json_field .)"
echo "Withdrawable balance: $balance yoctoNEAR" >&2
call withdraw '{}' '1 yoctoNEAR'

printf '\nOracle: %s\nAssertion %s settled with outcome %s\n\nTransactions:\n' \
  "$oracle" "$assertion_id" "$(view get_outcome "{\"assertion_id\":$assertion_id}")"
printf '  %s\n' "${links[@]}"
