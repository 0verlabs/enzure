# Shared by the Sputnik DAO scripts. Source it after scripts/lib/near.sh and
# call near_keys_init first; don't run it.
#
# Signs as NEAR_ACCOUNT_ID with NEAR_PRIVATE_KEY through an access-key file
# (see near.sh), so private keys never appear in command lines. Large arguments
# (a proposal carrying the oracle's Wasm) go through files, not argv.

DAO_FACTORY="${DAO_FACTORY:-sputnikv2.testnet}"
links=()
last_output=""

step() { printf '\n==> %s\n' "$1" >&2; }

die() {
  echo "error: $*" >&2
  exit 1
}

require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || die "'$tool' not found, see docs/toolchain.md"
  done
}

# Runs a near CLI command that sends a transaction, records its NearBlocks link
# under LABEL in `links` and keeps its output in `last_output`.
send() {
  local label="$1" output hash
  shift
  if ! output="$(near "$@" 2>&1)"; then
    printf '%s\n' "$output" >&2
    hash="$(tx_hash_of "$output")"
    [ -z "$hash" ] || echo "Failed transaction: $NEAR_EXPLORER/$hash" >&2
    return 1
  fi
  hash="$(tx_hash_of "$output")"
  [ -n "$hash" ] || {
    printf '%s\nerror: no transaction hash in the output above\n' "$output" >&2
    return 1
  }
  links+=("$label: $NEAR_EXPLORER/$hash")
  echo "Transaction: $NEAR_EXPLORER/$hash" >&2
  last_output="$output"
}

# The return value of the last transaction sent with `send`.
last_return_value() {
  sed -n '/Function execution return value/{n;p;q;}' <<<"$last_output"
}

# The NEP-297 events the last transaction logged, one JSON object per line.
last_events() {
  sed -n 's/.*EVENT_JSON:\(.*\)$/\1/p' <<<"$last_output"
}

# Calls a view method; prints its JSON result.
view_on() {
  near --quiet contract call-function as-read-only "$1" "$2" json-args "$3" \
    network-config "$NEAR_NETWORK" now 2>/dev/null
}

# Reads a field from JSON on standard input: `json_field a.b` (`.` for the whole value).
json_field() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let value = JSON.parse(s);
      const path = process.argv[1] === "." ? [] : process.argv[1].split(".");
      for (const key of path) value = value?.[key];
      console.log(typeof value === "object" ? JSON.stringify(value) : String(value));
    });' "$1"
}

# Calls METHOD on CONTRACT as NEAR_ACCOUNT_ID with the arguments in FILE (JSON
# or raw bytes). Records the link under LABEL.
call_with_file() {
  local label="$1" contract="$2" method="$3" file="$4" deposit="$5" gas="${6:-300 Tgas}"
  send "$label" contract call-function as-transaction "$contract" "$method" file-args "$file" \
    prepaid-gas "$gas" attached-deposit "$deposit" sign-as "$NEAR_ACCOUNT_ID" \
    network-config "$NEAR_NETWORK" sign-with-access-key-file "$(near_key_file "$NEAR_ACCOUNT_ID")" send
}

# Calls METHOD on CONTRACT as NEAR_ACCOUNT_ID with JSON arguments.
call_json() {
  local label="$1" contract="$2" method="$3" args="$4" deposit="$5" gas="${6:-100 Tgas}"
  send "$label" contract call-function as-transaction "$contract" "$method" json-args "$args" \
    prepaid-gas "$gas" attached-deposit "$deposit" sign-as "$NEAR_ACCOUNT_ID" \
    network-config "$NEAR_NETWORK" sign-with-access-key-file "$(near_key_file "$NEAR_ACCOUNT_ID")" send
}

# Fails unless DAO is a Sputnik DAO with a policy we can read.
require_sputnik_dao() {
  local policy
  policy="$(view_on "$1" get_policy '{}')" || die "$1 is not a Sputnik DAO (no get_policy view)"
  [ -n "$policy" ] || die "$1 is not a Sputnik DAO (no get_policy view)"
}

# Files a Sputnik DAO FunctionCall proposal on DAO that calls METHOD on
# RECEIVER with the raw argument bytes in ARGS_FILE, attaching ACTION_DEPOSIT
# yoctoNEAR and ACTION_GAS gas. Pays the DAO's proposal bond. Sets
# `proposal_id`.
dao_propose_call() {
  local dao="$1" description="$2" receiver="$3" method="$4" args_file="$5"
  local action_deposit="${6:-1}" action_gas="${7:-100000000000000}" bond proposal_file id
  require_sputnik_dao "$dao"
  bond="$(view_on "$dao" get_policy '{}' | json_field proposal_bond)"
  proposal_file="$NEAR_KEYS_DIR/proposal-$RANDOM.json"
  node -e '
    const fs = require("fs");
    const [description, receiver, method, argsFile, deposit, gas, out] = process.argv.slice(1);
    const args = fs.readFileSync(argsFile).toString("base64");
    fs.writeFileSync(out, JSON.stringify({
      proposal: {
        description,
        kind: { FunctionCall: { receiver_id: receiver, actions: [{ method_name: method, args, deposit, gas }] } },
      },
    }));' "$description" "$receiver" "$method" "$args_file" "$action_deposit" "$action_gas" "$proposal_file"
  call_with_file "add_proposal $method" "$dao" add_proposal "$proposal_file" "$bond yoctoNEAR" '300 Tgas'
  id="$(last_return_value)"
  case "$id" in
    '' | *[!0-9]*) die "add_proposal returned '$id', not a proposal id" ;;
  esac
  proposal_id="$id"
  echo "Proposal $proposal_id on $dao: $description" >&2
}

# Votes VoteApprove on proposal ID of DAO as NEAR_ACCOUNT_ID, then waits for
# the proposal to leave InProgress. Sets `proposal_status`. Returns non-zero if
# the approved proposal's call failed.
dao_approve() {
  local dao="$1" id="$2" proposal act_file
  require_sputnik_dao "$dao"
  proposal="$(view_on "$dao" get_proposal "{\"id\":$id}")" || die "no proposal $id on $dao"
  act_file="$NEAR_KEYS_DIR/act-$id.json"
  # act_proposal must repeat the proposal's kind, so a vote can't land on a
  # different proposal than the one the voter read.
  node -e '
    const fs = require("fs");
    const proposal = JSON.parse(fs.readFileSync(0, "utf8"));
    if (proposal.status !== "InProgress") {
      console.error(`error: proposal is ${proposal.status}, not InProgress`);
      process.exit(1);
    }
    const id = Number(process.argv[1]);
    fs.writeFileSync(process.argv[2], JSON.stringify({ id, action: "VoteApprove", proposal: proposal.kind }));' \
    "$id" "$act_file" <<<"$proposal"
  call_with_file "approve proposal $id" "$dao" act_proposal "$act_file" '0 NEAR' '300 Tgas'
  proposal_status=""
  local tries=0
  while [ "$tries" -lt 10 ]; do
    proposal_status="$(view_on "$dao" get_proposal "{\"id\":$id}" | json_field status)"
    [ "$proposal_status" = "InProgress" ] || break
    tries=$((tries + 1))
    sleep 2
  done
  echo "Proposal $id is $proposal_status" >&2
  [ "$proposal_status" != "Failed" ]
}

# Writes JSON arguments to a file in the private folder and prints its path.
json_args_file() {
  local file="$NEAR_KEYS_DIR/args-$RANDOM.json"
  printf '%s' "$1" >"$file"
  printf '%s\n' "$file"
}

print_links() {
  [ "${#links[@]}" -eq 0 ] && return 0
  printf '\nTransactions:\n'
  printf '  %s\n' "${links[@]}"
}
