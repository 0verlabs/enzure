#!/usr/bin/env bash
# Runs an Appeal ruled by the DAO on NEAR testnet: posts an Assertion, disputes
# it from a new Disputer account, lets the AI Verdict deadline pass so
# `check_timeout` sends it to Appeal, then rules it through a DAO proposal
# calling `resolve_appeal` and prints how the bonds were split.
#
#   scripts/dao-appeal.sh <dao> <oracle>
#
# With no AI Verdict (reason `no_verdict`) the DAO's ruling settles it like an
# AI Verdict would: the winner gets their bond back plus half the loser's, the
# DAO the other half. Run it after setting a short AI Verdict deadline, e.g.
#   scripts/dao-propose.sh <dao> <oracle> set-config '{"ai_verdict_deadline":60}'
#
# Needs near (near-cli-rs) and node, and in the environment or the .env:
#   NEAR_ACCOUNT_ID    a council member of the DAO; the Asserter, and the funder of
#                      the Disputer account disputer-<timestamp>.<NEAR_ACCOUNT_ID>
#   NEAR_PRIVATE_KEY   a full-access key of NEAR_ACCOUNT_ID (ed25519:...)
# Optional:
#   RULING          true or false, the DAO's ruling (true)
#   LIVENESS_SECS   Liveness of the Assertion (60)
#   BOND_YOCTO      the bond, at least the oracle's min_bond (the min_bond)
# The proposal passes on the proposer's own vote only if the DAO needs one vote;
# otherwise the script stops after proposing and prints the proposal id for
# scripts/dao-approve.sh.
#
# Needs about bond × 2 + 0.3 testnet NEAR; the winner withdraws theirs at the end.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/near.sh
source "$root/scripts/lib/near.sh"
# shellcheck source=scripts/lib/dao.sh
source "$root/scripts/lib/dao.sh"

[ "$#" -eq 2 ] || { sed -n '7p' "$0" | sed 's/^# //' >&2; exit 2; }
dao="$1" oracle="$2"
load_env "$root" NEAR_ACCOUNT_ID NEAR_PRIVATE_KEY
require_tools near node
: "${NEAR_ACCOUNT_ID:?Set NEAR_ACCOUNT_ID to a council member of the DAO}"
: "${NEAR_PRIVATE_KEY:?Set NEAR_PRIVATE_KEY to a full-access key of NEAR_ACCOUNT_ID}"
export NEAR_PRIVATE_KEY
ruling="${RULING:-true}"
case "$ruling" in true | false) ;; *) die "RULING must be true or false" ;; esac
liveness="${LIVENESS_SECS:-60}"
near_keys_init

config="$(view_on "$oracle" get_config '{}')" || die "$oracle is not an Enzure oracle"
[ "$(json_field dao <<<"$config")" = "$dao" ] || die "$oracle's DAO is not $dao"
bond="${BOND_YOCTO:-$(json_field min_bond <<<"$config")}"
ai_deadline="$(json_field ai_verdict_deadline <<<"$config")"
oracle_view() { view_on "$oracle" "$@"; }
balance_of() { oracle_view get_balance "{\"account_id\":\"$1\"}" | json_field .; }

disputer="disputer-$(date +%s).$NEAR_ACCOUNT_ID"
step "Creating the Disputer account $disputer"
send "create Disputer" account create-account fund-myself "$disputer" \
  "$(yocto_add "$bond" 200000000000000000000000) yoctoNEAR" \
  use-manually-provided-public-key "$NEAR_PUBLIC_KEY" sign-as "$NEAR_ACCOUNT_ID" \
  network-config "$NEAR_NETWORK" sign-with-access-key-file "$(near_key_file "$NEAR_ACCOUNT_ID")" send

claim_hash="$(node -e 'console.log(require("crypto").createHash("sha256").update(`Enzure DAO Appeal demo ${Date.now()}`).digest("hex"))')"
step "Posting an Assertion with a ${liveness}-second Liveness and a bond of $bond yoctoNEAR"
storage="$(oracle_view assertion_storage_deposit '{}' | json_field .)"
call_json assert_claim "$oracle" assert_claim \
  "{\"claim_hash\":\"$claim_hash\",\"bond\":\"$bond\",\"liveness\":$liveness,\"hooks\":[]}" \
  "$(yocto_add "$bond" "$storage") yoctoNEAR"
id="$(last_return_value)"
case "$id" in '' | *[!0-9]*) die "assert_claim returned '$id'" ;; esac

step "Disputing Assertion $id as $disputer"
dispute_storage="$(oracle_view dispute_storage_deposit '{}' | json_field .)"
send dispute contract call-function as-transaction "$oracle" dispute json-args "{\"assertion_id\":$id}" \
  prepaid-gas '100 Tgas' attached-deposit "$(yocto_add "$bond" "$dispute_storage") yoctoNEAR" \
  sign-as "$disputer" network-config "$NEAR_NETWORK" sign-with-access-key-file "$(near_key_file "$disputer")" send

step "Waiting ${ai_deadline}s for the AI Verdict deadline (no Resolver runs for this Assertion)"
deadline_ns="$(oracle_view get_assertion "{\"assertion_id\":$id}" | json_field dispute.ai_verdict_deadline_ns)"
while node -e 'process.exit(BigInt(Date.now()) * 1000000n >= BigInt(process.argv[1]) + 5000000000n ? 1 : 0)' "$deadline_ns"; do
  sleep 5
done
call_json check_timeout "$oracle" check_timeout "{\"assertion_id\":$id}" '0 NEAR'
appeal="$(oracle_view get_assertion "{\"assertion_id\":$id}" | json_field appeal)"
echo "Assertion $id is in Appeal: $appeal" >&2

before_dao="$(balance_of "$dao")"
step "Proposing the DAO ruling $ruling"
args_file="$(json_args_file "{\"assertion_id\":$id,\"truthful\":$ruling}")"
dao_propose_call "$dao" "Rule Assertion $id under Appeal: $( [ "$ruling" = true ] && echo TRUE || echo FALSE )." \
  "$oracle" resolve_appeal "$args_file" 1 150000000000000
dao_approve "$dao" "$proposal_id" || die "proposal $proposal_id was approved but resolve_appeal failed"
last_events >&2 || true
if [ "$proposal_status" != Approved ]; then
  print_links
  printf '\nProposal %s is %s; other council members approve it with:\n  scripts/dao-approve.sh %s %s\n' \
    "$proposal_id" "$proposal_status" "$dao" "$proposal_id"
  exit 0
fi

outcome="$(oracle_view get_outcome "{\"assertion_id\":$id}")"
asserter_balance="$(balance_of "$NEAR_ACCOUNT_ID")"
disputer_balance="$(balance_of "$disputer")"
dao_balance="$(balance_of "$dao")"
printf '\nAssertion %s settled %s by the DAO. Oracle balances (yoctoNEAR):\n  Asserter %s: %s\n  Disputer %s: %s\n  DAO %s: %s (was %s)\n' \
  "$id" "$outcome" "$NEAR_ACCOUNT_ID" "$asserter_balance" "$disputer" "$disputer_balance" "$dao" "$dao_balance" "$before_dao" >&2

step "Withdrawing the winner's balance"
if [ "$ruling" = true ]; then
  call_json withdraw "$oracle" withdraw '{}' '1 yoctoNEAR'
else
  send withdraw contract call-function as-transaction "$oracle" withdraw json-args '{}' \
    prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$disputer" \
    network-config "$NEAR_NETWORK" sign-with-access-key-file "$(near_key_file "$disputer")" send
fi

printf '\nOracle %s, DAO %s, Assertion %s, proposal %s\n' "$oracle" "$dao" "$id" "$proposal_id"
print_links
