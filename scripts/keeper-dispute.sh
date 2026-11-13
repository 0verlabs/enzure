#!/usr/bin/env bash
# Runs a disputed Assertion through the oracle on NEAR testnet with the Keeper
# doing the rest: deploys the oracle to a fresh development account, publishes
# Prompt Template v1 and registers the model's attested signing key, uploads a
# Claim and both Evidence items to the storage service, posts and disputes an
# Assertion, then starts the Keeper (typescript/apps/keeper) and waits until
# the Keeper has submitted the AI Verdict and settled the Assertion. Prints a
# NearBlocks link for every transaction, the Keeper's included.
#
# Needs near (near-cli-rs), cargo-near and node (see docs/toolchain.md), the
# Keeper built (`vp install && vp run --filter @enzure/keeper build` in
# typescript/), and in the environment or the repository's .env:
#   NEAR_ACCOUNT_ID    a funded testnet account: the DAO, Asserter, Disputer and Keeper signer
#   NEAR_PRIVATE_KEY   a full-access key of NEAR_ACCOUNT_ID (ed25519:...)
#   NEARAI_API_KEY     NEAR AI Cloud key, for the Keeper and the attested-key lookup
# Optional:
#   STORAGE_URL         storage service (the deployed one)
#   LIVENESS_SECS       Liveness of the Assertion (120)
#   APPEAL_WINDOW_SECS  Appeal Window the DAO configures (60, the minimum)
#   BOND_YOCTO          bond in yoctoNEAR (1 NEAR)
#   ORACLE_BALANCE      NEAR given to the development account ("4 NEAR")
#   ORACLE_ACCOUNT_ID   reuse an oracle already set up by this script
#   NO_KEEPER=1         don't start a Keeper; wait for one already running on this oracle
#
# Needs about 7 testnet NEAR: ORACLE_BALANCE stays on the development account
# (delete it to recover it); the winner's bonds come back through withdraw.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/near.sh
source "$root/scripts/lib/near.sh"
# shellcheck source=scripts/lib/storage.sh
source "$root/scripts/lib/storage.sh"

load_env "$root" NEAR_ACCOUNT_ID NEAR_PRIVATE_KEY NEARAI_API_KEY STORAGE_URL
for tool in near cargo node curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' not found, see docs/toolchain.md" >&2; exit 1; }
done
: "${NEAR_ACCOUNT_ID:?Set NEAR_ACCOUNT_ID to a funded testnet account}"
: "${NEAR_PRIVATE_KEY:?Set NEAR_PRIVATE_KEY to a full-access key of NEAR_ACCOUNT_ID}"
: "${NEARAI_API_KEY:?Set NEARAI_API_KEY (see .env.example)}"
export NEAR_PRIVATE_KEY NEARAI_API_KEY
liveness="${LIVENESS_SECS:-120}"
appeal_window="${APPEAL_WINDOW_SECS:-60}"
bond="${BOND_YOCTO:-1000000000000000000000000}"
oracle_balance="${ORACLE_BALANCE:-4 NEAR}"
keeper="$root/typescript/apps/keeper/dist/main.mjs"
if [ -z "${NO_KEEPER:-}" ] && [ ! -f "$keeper" ]; then
  echo "error: build the Keeper first: (cd typescript && vp install && vp run --filter @enzure/keeper build)" >&2
  exit 1
fi

near_keys_init
signer_key="$(near_key_file "$NEAR_ACCOUNT_ID")"

step() { printf '\n==> %s\n' "$1" >&2; }

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

last_return_value() {
  sed -n '/Function execution return value/{n;p;q;}' <<<"$last_output"
}

view() {
  near --quiet contract call-function as-read-only "$oracle" "$1" json-args "$2" \
    network-config "$NEAR_NETWORK" now 2>/dev/null
}

call() {
  send "$1" contract call-function as-transaction "$oracle" "$1" json-args "$2" \
    prepaid-gas '100 Tgas' attached-deposit "$3" sign-as "$NEAR_ACCOUNT_ID" \
    network-config "$NEAR_NETWORK" sign-with-access-key-file "$signer_key" send
}

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
fixture="$root/fixtures/near-ai-cloud/signed-response.json"

if [ -n "${ORACLE_ACCOUNT_ID:-}" ]; then
  oracle="$ORACLE_ACCOUNT_ID"
  step "Reusing the oracle $oracle"
else
  oracle="oracle-$(date +%s).$NEAR_ACCOUNT_ID"
  oracle_key="$(near_key_file "$oracle")"

  step "Building the oracle"
  (cd "$root/contracts/near/oracle" && cargo near build non-reproducible-wasm --locked >&2)
  wasm="$root/contracts/near/target/near/oracle/oracle.wasm"

  step "Creating the development account $oracle"
  send "create development account" account create-account fund-myself "$oracle" "$oracle_balance" \
    use-manually-provided-public-key "$NEAR_PUBLIC_KEY" sign-as "$NEAR_ACCOUNT_ID" \
    network-config "$NEAR_NETWORK" sign-with-access-key-file "$signer_key" send

  step "Deploying the oracle with $NEAR_ACCOUNT_ID as its DAO"
  send "deploy" contract deploy "$oracle" use-file "$wasm" with-init-call new \
    json-args "{\"dao\":\"$NEAR_ACCOUNT_ID\"}" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
    network-config "$NEAR_NETWORK" sign-with-access-key-file "$oracle_key" send

  step "DAO: Appeal Window ${appeal_window}s, Prompt Template v1, the model's attested key"
  config="$(view get_config '{}' | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const { dao, ...config } = JSON.parse(s);
      console.log(JSON.stringify({ config: { ...config, appeal_window: Number(process.argv[1]) } }));
    });' "$appeal_window")"
  call set_config "$config" '1 yoctoNEAR'
  # The fixture's Prompt Template is core's PROMPT_TEMPLATE_V1, the one the contract tests replay.
  template="$(node -e '
    const { prompt_template: t } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const { version, ...template } = t;
    console.log(JSON.stringify({ template }));' "$fixture")"
  call publish_prompt_template "$template" '1 yoctoNEAR'
  model="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).model_id)' "$fixture")"
  # The ed25519 key in the model's attestation report signs its responses. The
  # check reads NEARAI_API_KEY from the environment, so the key never reaches argv.
  attested="$(node "$root/scripts/near-ai-attested-key.mts" --model "$model")" ||
    { echo "error: no attested ed25519 key for $model" >&2; exit 1; }
  call add_registered_key "{\"public_key\":\"$attested\",\"model_id\":\"$model\"}" '1 yoctoNEAR'
fi

step "Uploading the Claim and both Evidence items to $STORAGE_URL"
for field in claim asserter_evidence disputer_evidence; do
  node -e '
    const { input } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(input[process.argv[2]]);' "$fixture" "$field" >"$NEAR_KEYS_DIR/$field.txt"
done
claim_hash="$("$root/scripts/storage-upload.sh" "$NEAR_KEYS_DIR/claim.txt")"
evidence_hash="$("$root/scripts/storage-upload.sh" "$NEAR_KEYS_DIR/asserter_evidence.txt")"
disputer_evidence_hash="$("$root/scripts/storage-upload.sh" "$NEAR_KEYS_DIR/disputer_evidence.txt")"

step "Posting an Assertion with a ${liveness}-second Liveness"
storage="$(view assertion_storage_deposit '{}' | json_field .)"
call assert_claim \
  "{\"claim_hash\":\"$claim_hash\",\"evidence_hash\":\"$evidence_hash\",\"bond\":\"$bond\",\"liveness\":$liveness,\"hooks\":[]}" \
  "$(yocto_add "$bond" "$storage") yoctoNEAR"
assertion_id="$(last_return_value)"
case "$assertion_id" in
  '' | *[!0-9]*) echo "error: assert_claim returned '$assertion_id', not an Assertion id" >&2; exit 1 ;;
esac

step "Disputing Assertion $assertion_id with the Disputer's Evidence"
dispute_storage="$(view dispute_storage_deposit '{}' | json_field .)"
call dispute "{\"assertion_id\":$assertion_id,\"evidence_hash\":\"$disputer_evidence_hash\"}" \
  "$(yocto_add "$bond" "$dispute_storage") yoctoNEAR"

keeper_log="$NEAR_KEYS_DIR/keeper.log"
if [ -z "${NO_KEEPER:-}" ]; then
  step "Starting the Keeper; it resolves and settles from here (log: $keeper_log)"
  # The key reaches the Keeper through its environment, never its command line.
  ORACLE_ACCOUNT_ID="$oracle" NEAR_ACCOUNT_ID="$NEAR_ACCOUNT_ID" NEAR_NETWORK="$NEAR_NETWORK" \
    STORAGE_URL="$STORAGE_URL" POLL_INTERVAL_MS="${POLL_INTERVAL_MS:-5000}" \
    node "$keeper" >"$keeper_log" 2>&1 &
  keeper_pid=$!
  trap 'kill "$keeper_pid" 2>/dev/null || true; rm -rf "$NEAR_KEYS_DIR"' EXIT
else
  step "Waiting for the running Keeper to resolve and settle Assertion $assertion_id"
fi

deadline=$(( $(date +%s) + liveness + appeal_window + 600 ))
state=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  state="$(view get_assertion "{\"assertion_id\":$assertion_id}" | json_field state)"
  [ "$state" = "settled" ] && break
  echo "Assertion $assertion_id is $state" >&2
  sleep 10
done

if [ -n "${NO_KEEPER:-}" ]; then :; else
  kill "$keeper_pid" 2>/dev/null || true
  wait "$keeper_pid" 2>/dev/null || true
  echo "--- Keeper log ---" >&2
  cat "$keeper_log" >&2
  while IFS= read -r line; do links+=("Keeper $line"); done < <(node -e '
    for (const line of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) {
      try { const e = JSON.parse(line); if (e.event === "transaction") console.log(`${e.method}: ${e.tx}`); } catch {}
    }' "$keeper_log")
fi
[ "$state" = "settled" ] || { echo "error: Assertion $assertion_id is still $state" >&2; exit 1; }

step "Withdrawing the winnings"
call withdraw '{}' '1 yoctoNEAR'

printf '\nOracle: %s\nAssertion %s settled with outcome %s\n\nTransactions:\n' \
  "$oracle" "$assertion_id" "$(view get_outcome "{\"assertion_id\":$assertion_id}")"
printf '  %s\n' "${links[@]}"
