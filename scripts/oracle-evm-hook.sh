#!/usr/bin/env bash
# Signs one EVM Hook through Chain Signatures on NEAR testnet: deploys the
# oracle to a fresh development account, posts an Assertion with one EVM Hook
# and a short Liveness, settles it, calls `sign_hook`, prints the signed result
# and the oracle's derived EVM address, and withdraws the bond.
# With --write-fixture it also writes fixtures/chain-signatures/signed-result.json.
#
# Needs near (near-cli-rs), cargo-near and node (see docs/toolchain.md), and a
# funded testnet account in the environment or the repository's .env:
#   NEAR_ACCOUNT_ID    the Asserter, and parent of the development account
#   NEAR_PRIVATE_KEY   a full-access key of NEAR_ACCOUNT_ID (ed25519:...)
# Optional:
#   ORACLE_ACCOUNT_ID      reuse this deployed oracle instead of deploying a new one,
#                          e.g. one a Receiver is already configured for
#   ORACLE_DAO_ACCOUNT_ID  DAO the oracle is initialised with (NEAR_ACCOUNT_ID)
#   EVM_SIGNER             Chain Signatures signer (v1.signer-prod.testnet)
#   EVM_CHAIN_ID           chain id of the EVM Hook (84532, Base Sepolia)
#   EVM_RECEIVER           Receiver address (0x1000000000000000000000000000000000000001)
#   EVM_CONSUMER           Consumer address (0x2000000000000000000000000000000000000002)
#   SIGN_DEPOSIT           deposit for the signer ("1 yoctoNEAR")
#   LIVENESS_SECS          Liveness of the Assertion, 60 to 604800 (60)
#   BOND_YOCTO             bond in yoctoNEAR (1 NEAR)
#   ORACLE_BALANCE         NEAR given to the development account ("3 NEAR")
#
# The development account is <name>.<NEAR_ACCOUNT_ID> and has the same key, so
# it can be deleted afterwards to recover its balance. Its derived EVM address
# is printed; keep the account if a Receiver is configured with that address.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/near.sh
source "$root/scripts/lib/near.sh"
# shellcheck source=scripts/lib/storage.sh
source "$root/scripts/lib/storage.sh"

write_fixture=false
case "${1:-}" in
  --write-fixture) write_fixture=true ;;
  '') ;;
  *) echo "usage: $0 [--write-fixture]" >&2; exit 2 ;;
esac

load_env "$root" NEAR_ACCOUNT_ID NEAR_PRIVATE_KEY ORACLE_DAO_ACCOUNT_ID
for tool in near cargo node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' not found, see docs/toolchain.md (node comes with Vite+)" >&2; exit 1; }
done
: "${NEAR_ACCOUNT_ID:?Set NEAR_ACCOUNT_ID to a funded testnet account}"
: "${NEAR_PRIVATE_KEY:?Set NEAR_PRIVATE_KEY to a full-access key of NEAR_ACCOUNT_ID}"
export NEAR_PRIVATE_KEY
dao="${ORACLE_DAO_ACCOUNT_ID:-$NEAR_ACCOUNT_ID}"
evm_signer="${EVM_SIGNER:-v1.signer-prod.testnet}"
chain_id="${EVM_CHAIN_ID:-84532}"
receiver="${EVM_RECEIVER:-0x1000000000000000000000000000000000000001}"
consumer="${EVM_CONSUMER:-0x2000000000000000000000000000000000000002}"
sign_deposit="${SIGN_DEPOSIT:-1 yoctoNEAR}"
liveness="${LIVENESS_SECS:-60}"
bond="${BOND_YOCTO:-1000000000000000000000000}"
oracle_balance="${ORACLE_BALANCE:-3 NEAR}"
oracle="${ORACLE_ACCOUNT_ID:-oracle-$(date +%s).$NEAR_ACCOUNT_ID}"

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

# Calls an oracle method as the Asserter, with 100 Tgas unless a fourth
# argument gives the gas.
call() {
  send "$1" contract call-function as-transaction "$oracle" "$1" json-args "$2" \
    prepaid-gas "${4:-100 Tgas}" attached-deposit "$3" sign-as "$NEAR_ACCOUNT_ID" \
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

if [ -n "${ORACLE_ACCOUNT_ID:-}" ]; then
  step "Using the deployed oracle $oracle"
else
  step "Building the oracle"
  (cd "$root/contracts/near/oracle" && cargo near build non-reproducible-wasm --locked >&2)
  wasm="$root/contracts/near/target/near/oracle/oracle.wasm"

  step "Creating the development account $oracle"
  send "create development account" account create-account fund-myself "$oracle" "$oracle_balance" \
    use-manually-provided-public-key "$NEAR_PUBLIC_KEY" sign-as "$NEAR_ACCOUNT_ID" \
    network-config "$NEAR_NETWORK" sign-with-access-key-file "$asserter_key" send

  step "Deploying the oracle with $dao as its DAO and $evm_signer as its signer"
  send "deploy" contract deploy "$oracle" use-file "$wasm" with-init-call new \
    json-args "{\"dao\":\"$dao\",\"evm_signer\":\"$evm_signer\"}" \
    prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config "$NEAR_NETWORK" \
    sign-with-access-key-file "$oracle_key" send
fi

step "Posting an Assertion with an EVM Hook for chain $chain_id"
claim="Enzure testnet run on $(date -u +%Y-%m-%dT%H:%M:%SZ): this Assertion's EVM Hook is signed with Chain Signatures."
printf '%s' "$claim" >"$NEAR_KEYS_DIR/claim.txt"
claim_hash="$(sha256_of "$NEAR_KEYS_DIR/claim.txt")"
storage="$(view assertion_storage_deposit '{"hooks":1}' | json_field .)"
deposit="$(yocto_add "$bond" "$storage")"
hook="{\"evm\":{\"chain_id\":$chain_id,\"receiver\":\"$receiver\",\"consumer\":\"$consumer\"}}"
call assert_claim \
  "{\"claim_hash\":\"$claim_hash\",\"bond\":\"$bond\",\"liveness\":$liveness,\"hooks\":[$hook]}" \
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

step "Signing the EVM Hook with $evm_signer"
call sign_hook "{\"assertion_id\":$assertion_id,\"hook_index\":0}" "$sign_deposit" '300 Tgas'
sign_tx="$(tx_hash_of "$last_output")"
signed="$(last_return_value)"
if [ "$signed" != "true" ]; then
  echo "error: sign_hook returned '$signed'; the signer failed or timed out, run sign_hook again" >&2
  exit 1
fi
signed_result="$(view get_signed_result "{\"assertion_id\":$assertion_id,\"hook_index\":0}")"
derived="$(node "$root/scripts/oracle-evm-address.mts" "$oracle")"

step "Withdrawing the bond"
call withdraw '{}' '1 yoctoNEAR'

if [ "$write_fixture" = true ]; then
  fixture="$root/fixtures/chain-signatures/signed-result.json"
  mkdir -p "$(dirname "$fixture")"
  # The signer'''s raw answer is the SuccessValue of its receipt in the sign_hook
  # transaction; the fixture keeps it next to the oracle'''s signed result.
  SIGNED_RESULT="$signed_result" DERIVED="$derived" SIGN_TX="$sign_tx" CLAIM="$claim" \
    SENDER="$NEAR_ACCOUNT_ID" SIGNER="$evm_signer" node --input-type=module -e '
    const { SIGNED_RESULT, DERIVED, SIGN_TX, CLAIM, SENDER, SIGNER } = process.env;
    const response = await fetch("https://archival-rpc.testnet.near.org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "enzure",
        method: "EXPERIMENTAL_tx_status",
        params: { tx_hash: SIGN_TX, sender_account_id: SENDER, wait_until: "FINAL" },
      }),
    }).then((r) => r.json());
    const answers = response.result.receipts_outcome
      .filter((o) => o.outcome.executor_id === SIGNER && o.outcome.status.SuccessValue)
      .map((o) => JSON.parse(Buffer.from(o.outcome.status.SuccessValue, "base64").toString()));
    const signerResponse = answers.find((a) => a && a.big_r);
    if (!signerResponse) throw new Error("no signer response in transaction " + SIGN_TX);
    const fixture = {
      network: "testnet",
      ...JSON.parse(DERIVED),
      claim: CLAIM,
      sign_hook_transaction: SIGN_TX,
      signer_response: signerResponse,
      signed_result: JSON.parse(SIGNED_RESULT),
    };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.argv[1], JSON.stringify(fixture, null, 2) + "\n");
  ' "$fixture"
  echo "Wrote $fixture" >&2
fi

printf '\nOracle: %s\nDerived EVM address: %s\nSigned result:\n%s\n\nTransactions:\n' \
  "$oracle" "$(json_field address <<<"$derived")" "$signed_result"
printf '  %s\n' "${links[@]}"
