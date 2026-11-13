#!/usr/bin/env bash
# The escrow demo end to end, on NEAR testnet and Base Sepolia:
#
#   1. Deploys the Receiver for the oracle and the escrow, unless given.
#   2. The buyer fills in the Claim, uploads it and funds a job (buyer.mts create-job).
#   3. The seller agent writes the deliverable with NEAR AI, uploads it as
#      Evidence and posts the Assertion with an EVM Hook to the escrow (seller.mts).
#   4. The buyer disputes it with its own Evidence (buyer.mts dispute).
#   5. The Keeper gets the AI Verdict, settles after the Appeal Window, has the
#      Hook signed through Chain Signatures and relays it to the Receiver.
#   6. The escrow pays the seller (TRUE) or refunds the buyer (FALSE).
#
# Prints every transaction link at the end.
#
#   ./examples/escrow/demo.sh paid       # an honest seller; the AI should rule TRUE
#   ./examples/escrow/demo.sh refunded   # the seller ignores the brief; the AI should rule FALSE
#
# The AI decides, so the outcome is what the model rules, not what you asked
# for; the script reports which one happened.
#
# Needs near (near-cli-rs), forge, cast and node (docs/toolchain.md), the
# Keeper built (`vp install && vp run --filter @enzure/keeper build` in
# typescript/), and in the environment or the repository's .env:
#   NEAR_ACCOUNT_ID    the buyer on NEAR (the Disputer), funded testnet account; it also
#                      funds the seller's account and signs the Keeper's calls
#   NEAR_PRIVATE_KEY   a full-access key of NEAR_ACCOUNT_ID (ed25519:...)
#   NEARAI_API_KEY     NEAR AI Cloud, for the seller agent and the Keeper's Resolver
#   EVM_PRIVATE_KEY    the buyer on Base Sepolia: deploys, funds the job and pays the
#                      Relayer's gas; needs Base Sepolia ETH and test USDC
# Optional:
#   ORACLE_ACCOUNT_ID  the oracle (the DAO-governed testnet deployment)
#   EVM_RPC_URL        https://sepolia.base.org
#   RECEIVER_ADDRESS   the oracle's Receiver; deployed with scripts/deploy-receiver.sh if unset
#   ESCROW_ADDRESS     the escrow; deployed if unset, with USDC_ADDRESS as its token
#   USDC_ADDRESS       Circle's test USDC on Base Sepolia (0x036CbD53842c5426634e7929541eC2318f3dCF7e);
#                      TEST_USDC=1 deploys the fallback TestUSDC instead and mints to the buyer
#   SELLER_NEAR_ACCOUNT_ID, SELLER_NEAR_PRIVATE_KEY   the seller agent's NEAR account; if unset,
#                      creates seller-<timestamp>.<NEAR_ACCOUNT_ID> with SELLER_BALANCE (1.5 NEAR)
#   SELLER_EVM_ADDRESS the seller's payout address (a fresh address if unset)
#   AMOUNT             USDC for the job (1); BRIEF the job's brief
#   LIVENESS_SECS      the Assertion's Liveness (60, the oracle's minimum)
#   STORAGE_URL        the storage service (the deployed one)
#   NO_KEEPER=1        don't start a Keeper; wait for one already running with the Base Relayer on
#   EVM_EXPLORER_TX    prefix for EVM transaction links (Basescan on chain 84532)
#
# NEAR cost: SELLER_BALANCE plus the buyer's 1 NEAR dispute bond and fees; the
# winner gets 1.5 NEAR back and this script withdraws it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
here="$root/examples/escrow"
# shellcheck source=scripts/lib/near.sh
source "$root/scripts/lib/near.sh"

outcome_wanted="${1:-paid}"
case "$outcome_wanted" in
  paid) off_brief="" ;;
  refunded) off_brief="--off-brief" ;;
  *) echo "usage: $0 [paid|refunded]" >&2; exit 2 ;;
esac

load_env "$root" NEAR_ACCOUNT_ID NEAR_PRIVATE_KEY NEARAI_API_KEY EVM_PRIVATE_KEY EVM_RPC_URL STORAGE_URL \
  ORACLE_ACCOUNT_ID RECEIVER_ADDRESS ESCROW_ADDRESS USDC_ADDRESS
for tool in near forge cast node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' not found, see docs/toolchain.md" >&2; exit 1; }
done
: "${NEAR_ACCOUNT_ID:?Set NEAR_ACCOUNT_ID to the funded testnet account of the buyer}"
: "${NEAR_PRIVATE_KEY:?Set NEAR_PRIVATE_KEY to a full-access key of NEAR_ACCOUNT_ID}"
: "${NEARAI_API_KEY:?Set NEARAI_API_KEY}"
: "${EVM_PRIVATE_KEY:?Set EVM_PRIVATE_KEY to the funded Base Sepolia key of the buyer}"
export NEAR_ACCOUNT_ID NEAR_PRIVATE_KEY NEARAI_API_KEY EVM_PRIVATE_KEY
export ORACLE_ACCOUNT_ID="${ORACLE_ACCOUNT_ID:-oracle-1794575543.enzure-council-a-1794575224.testnet}"
export EVM_RPC_URL="${EVM_RPC_URL:-https://sepolia.base.org}"
export STORAGE_URL="${STORAGE_URL:-https://enzure-storage.luckzivanius.workers.dev}"
liveness="${LIVENESS_SECS:-60}"
amount="${AMOUNT:-1}"
brief="${BRIEF:-Write a short poem about a lighthouse at night. It must have exactly three lines and use the word \"beam\".}"
keeper="$root/typescript/apps/keeper/dist/main.mjs"
if [ -z "${NO_KEEPER:-}" ] && [ ! -f "$keeper" ]; then
  echo "error: build the Keeper first: (cd typescript && vp install && vp run --filter @enzure/keeper build)" >&2
  exit 1
fi

near_keys_init
step() { printf '\n==> %s\n' "$1" >&2; }
links=()
json_field() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let value = JSON.parse(s.trim().split("\n").pop());
      for (const key of process.argv[1].split(".")) value = value[key];
      console.log(typeof value === "object" ? JSON.stringify(value) : String(value));
    });' "$1"
}
add_links() { while IFS= read -r line; do links+=("$line"); done < <(json_field links | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => JSON.parse(s).forEach((l) => console.log(l)));'); }
agent() { node "$here/agent/$1.mts" "${@:2}"; }

chain_id="$(cast chain-id --rpc-url "$EVM_RPC_URL")"
# The key stays in the environment: derive the buyer's address with viem, not on a command line.
buyer_evm="$(node -e '
  const { createRequire } = require("node:module");
  const r = createRequire(process.argv[1]);
  console.log(r("viem/accounts").privateKeyToAccount(process.env.EVM_PRIVATE_KEY).address);' \
  "$root/typescript/packages/core/package.json")"
echo "Oracle $ORACLE_ACCOUNT_ID; EVM chain $chain_id at $EVM_RPC_URL; buyer $NEAR_ACCOUNT_ID / $buyer_evm" >&2

if [ -z "${RECEIVER_ADDRESS:-}" ]; then
  step "Deploying the Receiver for $ORACLE_ACCOUNT_ID"
  RECEIVER_ADDRESS="$("$root/scripts/deploy-receiver.sh" "$ORACLE_ACCOUNT_ID" | json_field receiver)"
fi
export RECEIVER_ADDRESS
echo "Receiver: $RECEIVER_ADDRESS" >&2

if [ -z "${ESCROW_ADDRESS:-}" ]; then
  if [ -n "${TEST_USDC:-}" ]; then
    step "Deploying the escrow with the fallback TestUSDC"
    unset USDC_ADDRESS
  else
    export USDC_ADDRESS="${USDC_ADDRESS:-0x036CbD53842c5426634e7929541eC2318f3dCF7e}"
    step "Deploying the escrow with the token $USDC_ADDRESS"
  fi
  output="$(cd "$here" && forge script script/DeployEscrow.s.sol:DeployEscrow --rpc-url "$EVM_RPC_URL" --broadcast 2>&1)" ||
    { printf '%s\n' "$output" >&2; exit 1; }
  ESCROW_ADDRESS="$(sed -n 's/.*Escrow \(0x[0-9a-fA-F]\{40\}\) token.*/\1/p' <<<"$output" | head -n 1)"
  [ -n "$ESCROW_ADDRESS" ] || { printf '%s\nerror: no escrow address above\n' "$output" >&2; exit 1; }
fi
export ESCROW_ADDRESS
token="$(cast call "$ESCROW_ADDRESS" "token()(address)" --rpc-url "$EVM_RPC_URL")"
echo "Escrow: $ESCROW_ADDRESS (token $token, Receiver $(cast call "$ESCROW_ADDRESS" "receiver()(address)" --rpc-url "$EVM_RPC_URL"))" >&2

if [ -z "${SELLER_NEAR_ACCOUNT_ID:-}" ]; then
  SELLER_NEAR_ACCOUNT_ID="seller-$(date +%s).$NEAR_ACCOUNT_ID"
  SELLER_NEAR_PRIVATE_KEY="$NEAR_PRIVATE_KEY"
  step "Creating the seller agent's NEAR account $SELLER_NEAR_ACCOUNT_ID"
  output="$(near account create-account fund-myself "$SELLER_NEAR_ACCOUNT_ID" "${SELLER_BALANCE:-1.5 NEAR}" \
    use-manually-provided-public-key "$NEAR_PUBLIC_KEY" sign-as "$NEAR_ACCOUNT_ID" \
    network-config "$NEAR_NETWORK" sign-with-access-key-file "$(near_key_file "$NEAR_ACCOUNT_ID")" send 2>&1)" ||
    { printf '%s\n' "$output" >&2; exit 1; }
  links+=("create seller account: $NEAR_EXPLORER/$(tx_hash_of "$output")")
fi
: "${SELLER_NEAR_PRIVATE_KEY:?Set SELLER_NEAR_PRIVATE_KEY for SELLER_NEAR_ACCOUNT_ID}"
export SELLER_NEAR_ACCOUNT_ID SELLER_NEAR_PRIVATE_KEY
seller_evm="${SELLER_EVM_ADDRESS:-$(cast wallet new --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].address))')}"

step "Buyer: writing the Claim and funding job for $amount USDC"
job_json="$(agent buyer create-job --brief "$brief" --amount "$amount" --seller "$seller_evm" \
  --seller-near "$SELLER_NEAR_ACCOUNT_ID" --deadline-secs "${DEADLINE_SECS:-86400}")"
job_id="$(json_field job_id <<<"$job_json")"
add_links <<<"$job_json"
printf 'Claim:\n%s\n' "$(json_field claim <<<"$job_json")" >&2

step "Seller agent: producing the deliverable and posting the Assertion"
seller_json="$(agent seller --job "$job_id" --liveness "$liveness" ${off_brief:+"$off_brief"})"
assertion_id="$(json_field assertion_id <<<"$seller_json")"
add_links <<<"$seller_json"

step "Buyer: disputing Assertion $assertion_id"
dispute_json="$(agent buyer dispute --assertion "$assertion_id" \
  --evidence "${BUYER_EVIDENCE:-The deliverable does not satisfy the brief, so the job should be refunded.}")"
add_links <<<"$dispute_json"

keeper_log="$NEAR_KEYS_DIR/keeper.log"
if [ -z "${NO_KEEPER:-}" ]; then
  step "Starting the Keeper with the Relayer on; it resolves, settles, signs and relays (log: $keeper_log)"
  # Keys reach the Keeper through its environment, never its command line. The buyer's
  # EVM key pays the Relayer's gas on the chain at EVM_RPC_URL, which the Keeper takes as Base.
  NEAR_NETWORK="$NEAR_NETWORK" POLL_INTERVAL_MS="${POLL_INTERVAL_MS:-5000}" \
    BASE_RPC_URL="$EVM_RPC_URL" BASE_RELAYER_KEY="$EVM_PRIVATE_KEY" node "$keeper" >"$keeper_log" 2>&1 &
  keeper_pid=$!
  trap 'kill "$keeper_pid" 2>/dev/null || true; rm -rf "$NEAR_KEYS_DIR"' EXIT
fi

step "Waiting for the escrow to pay or refund job $job_id"
deadline=$(( $(date +%s) + liveness + 1200 ))
status="funded"
while [ "$(date +%s)" -lt "$deadline" ]; do
  status="$(agent buyer job --job "$job_id" | json_field status)"
  [ "$status" = "funded" ] || break
  state="$(near --quiet contract call-function as-read-only "$ORACLE_ACCOUNT_ID" get_assertion \
    json-args "{\"assertion_id\":$assertion_id}" network-config "$NEAR_NETWORK" now 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);console.log(a.state+" "+JSON.stringify(a.hooks.map(h=>h.evm?.status)))})' || true)"
  echo "Assertion $assertion_id: $state; job $job_id: $status" >&2
  sleep 10
done

if [ -z "${NO_KEEPER:-}" ]; then
  kill "$keeper_pid" 2>/dev/null || true
  wait "$keeper_pid" 2>/dev/null || true
  echo "--- Keeper log ---" >&2
  cat "$keeper_log" >&2
  while IFS= read -r line; do links+=("Keeper $line"); done < <(EXPLORER="$(EVM_EXPLORER_TX="${EVM_EXPLORER_TX:-}" node -e '
    const id = Number(process.argv[1]);
    console.log(process.env.EVM_EXPLORER_TX || (id === 84532 ? "https://sepolia.basescan.org/tx/" : ""))' "$chain_id")" node -e '
    for (const line of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.assertion_id !== undefined && e.assertion_id !== Number(process.argv[2])) continue;
      if (e.assertionId !== undefined && e.assertionId !== Number(process.argv[2])) continue;
      if (e.event === "transaction") console.log(`${e.method}: ${e.tx}`);
      if (e.event === "relayer_delivered") console.log(`Relayer deliver: ${process.env.EXPLORER}${e.transactionHash}`);
    }' "$keeper_log" "$assertion_id")
fi
[ "$status" != "funded" ] || { echo "error: job $job_id is still funded" >&2; exit 1; }

job_after="$(agent buyer job --job "$job_id")"
outcome="$(near --quiet contract call-function as-read-only "$ORACLE_ACCOUNT_ID" get_outcome \
  json-args "{\"assertion_id\":$assertion_id}" network-config "$NEAR_NETWORK" now 2>/dev/null || true)"

step "Withdrawing the winner's bond from the oracle"
if [ "$status" = "paid" ]; then winner="$SELLER_NEAR_ACCOUNT_ID"; winner_key="$SELLER_NEAR_PRIVATE_KEY"; else winner="$NEAR_ACCOUNT_ID"; winner_key="$NEAR_PRIVATE_KEY"; fi
if [ "$winner_key" = "$NEAR_PRIVATE_KEY" ]; then
  output="$(near contract call-function as-transaction "$ORACLE_ACCOUNT_ID" withdraw json-args '{}' \
    prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$winner" network-config "$NEAR_NETWORK" \
    sign-with-access-key-file "$(near_key_file "$winner")" send 2>&1)" && links+=("withdraw ($winner): $NEAR_EXPLORER/$(tx_hash_of "$output")") ||
    printf '%s\n' "$output" >&2
else
  echo "Skipped: $winner signs with its own key; it can call withdraw on $ORACLE_ACCOUNT_ID" >&2
fi

printf '\nAsked for: %s. Outcome on NEAR: %s. Escrow job %s: %s\n' "$outcome_wanted" "$outcome" "$job_id" "$status"
printf 'Job: %s\n' "$job_after"
printf 'Seller payout address %s, seller NEAR %s, Assertion %s\n\nTransactions:\n' \
  "$seller_evm" "$SELLER_NEAR_ACCOUNT_ID" "$assertion_id"
printf '  %s\n' "${links[@]}"
