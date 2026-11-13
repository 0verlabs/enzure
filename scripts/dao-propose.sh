#!/usr/bin/env bash
# Files a Sputnik DAO proposal that calls one of the oracle's DAO-only methods.
#
#   scripts/dao-propose.sh <dao> <oracle> register-key [model-id]
#   scripts/dao-propose.sh <dao> <oracle> remove-key <public-key-hex>
#   scripts/dao-propose.sh <dao> <oracle> publish-template [template.json]
#   scripts/dao-propose.sh <dao> <oracle> set-config '<JSON with the fields to change>'
#   scripts/dao-propose.sh <dao> <oracle> resolve-appeal <assertion-id> <true|false>
#   scripts/dao-propose.sh <dao> <oracle> upgrade [oracle.wasm]
#
# register-key first runs the off-chain attestation check
# (scripts/near-ai-attested-key.mts) for the model (Prompt Template v1's by
# default) and prints it; it proposes the attested key only if the check passes.
# publish-template defaults to the template in fixtures/near-ai-cloud. set-config
# merges the given fields into the oracle's current config, e.g.
# '{"default_liveness":120,"appeal_window":60}'. upgrade builds the oracle unless
# given a Wasm file, and names the code's sha256 in the proposal so voters can
# compare it with their own build.
#
# Prints the proposal id. Other council members approve it with
# scripts/dao-approve.sh. With APPROVE=1 the proposer also votes for it, which
# passes it when the policy needs one vote, and the script prints the view that
# shows the change.
#
# Needs near (near-cli-rs) and node, and in the environment or the .env:
#   NEAR_ACCOUNT_ID    a council member of the DAO
#   NEAR_PRIVATE_KEY   a full-access key of NEAR_ACCOUNT_ID (ed25519:...)
#   NEARAI_API_KEY     for register-key only
# Optional: APPROVE=1, ACTION_GAS (gas for the oracle call, in gas units;
# 100 TGas, 150 TGas for upgrade and resolve-appeal).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/near.sh
source "$root/scripts/lib/near.sh"
# shellcheck source=scripts/lib/dao.sh
source "$root/scripts/lib/dao.sh"

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
[ "$#" -ge 3 ] || usage
dao="$1" oracle="$2" kind="$3"
shift 3

load_env "$root" NEAR_ACCOUNT_ID NEAR_PRIVATE_KEY NEARAI_API_KEY
require_tools near node
: "${NEAR_ACCOUNT_ID:?Set NEAR_ACCOUNT_ID to a council member of the DAO}"
: "${NEAR_PRIVATE_KEY:?Set NEAR_PRIVATE_KEY to a full-access key of NEAR_ACCOUNT_ID}"
export NEAR_PRIVATE_KEY
near_keys_init

oracle_config="$(view_on "$oracle" get_config '{}')" || die "$oracle is not an Enzure oracle (no get_config view)"
[ "$(json_field dao <<<"$oracle_config")" = "$dao" ] ||
  die "$oracle's DAO is $(json_field dao <<<"$oracle_config"), not $dao"
require_sputnik_dao "$dao"

gas="${ACTION_GAS:-100000000000000}"
case "$kind" in
  register-key)
    model="${1:-}"
    step "Off-chain attestation check of the model's signing key"
    key="$(node "$root/scripts/near-ai-attested-key.mts" ${model:+--model "$model"})" ||
      die "the attestation check failed; nothing was proposed"
    model="${model:-$(node -e '
      const { prompt_template: t } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      console.log(t.model_id);' "$root/fixtures/near-ai-cloud/signed-response.json")}"
    method=add_registered_key
    args="{\"public_key\":\"$key\",\"model_id\":\"$model\"}"
    description="Register NEAR AI Cloud key $key for $model. The proposer checked its attestation: one ed25519 attestation for the model, echoing a fresh nonce, with a TDX quote binding the key to that nonce."
    ;;
  remove-key)
    [ "$#" -eq 1 ] || usage
    method=remove_registered_key
    args="{\"public_key\":\"$1\"}"
    description="Remove Registered Key $1. AI Verdicts it already signed stay accepted."
    ;;
  publish-template)
    file="${1:-$root/fixtures/near-ai-cloud/signed-response.json}"
    method=publish_prompt_template
    args="$(node -e '
      const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const { version, ...template } = value.prompt_template ?? value;
      console.log(JSON.stringify({ template }));' "$file")"
    description="Publish a new Prompt Template version for model $(json_field template.model_id <<<"$args")."
    ;;
  set-config)
    [ "$#" -eq 1 ] || usage
    method=set_config
    args="$(node -e '
      const { dao, ...current } = JSON.parse(process.argv[1]);
      const changes = JSON.parse(process.argv[2]);
      for (const key of Object.keys(changes)) {
        if (!(key in current)) throw new Error(`unknown config field ${key}`);
      }
      console.log(JSON.stringify({ config: { ...current, ...changes } }));' "$oracle_config" "$1")"
    description="Change the oracle config: $1"
    ;;
  resolve-appeal)
    [ "$#" -eq 2 ] || usage
    case "$2" in true | false) ;; *) usage ;; esac
    state="$(view_on "$oracle" get_assertion "{\"assertion_id\":$1}" | json_field state)"
    [ "$state" = "in_appeal" ] || die "Assertion $1 is $state, not in_appeal"
    method=resolve_appeal
    args="{\"assertion_id\":$1,\"truthful\":$2}"
    description="Rule Assertion $1 under Appeal: $( [ "$2" = true ] && echo TRUE || echo FALSE )."
    gas="${ACTION_GAS:-150000000000000}"
    ;;
  upgrade)
    if [ "$#" -ge 1 ]; then
      wasm="$1"
    else
      require_tools cargo
      step "Building the oracle"
      (cd "$root/contracts/near/oracle" && cargo near build non-reproducible-wasm --locked >&2)
      wasm="$root/contracts/near/target/near/oracle/oracle.wasm"
    fi
    method=upgrade
    code_hash="$(node -e '
      const data = require("fs").readFileSync(process.argv[1]);
      console.log(require("crypto").createHash("sha256").update(data).digest("hex"));' "$wasm")"
    description="Upgrade the oracle to code with sha256 $code_hash ($(wc -c <"$wasm" | tr -d ' ') bytes)."
    gas="${ACTION_GAS:-150000000000000}"
    ;;
  *) usage ;;
esac

step "Proposing on $dao: $description"
if [ "$method" = upgrade ]; then
  args_file="$wasm"
else
  args_file="$(json_args_file "$args")"
fi
dao_propose_call "$dao" "$description" "$oracle" "$method" "$args_file" 1 "$gas"

if [ "${APPROVE:-}" = 1 ]; then
  step "Voting for proposal $proposal_id as $NEAR_ACCOUNT_ID"
  dao_approve "$dao" "$proposal_id" || die "proposal $proposal_id was approved but the oracle call failed"
  last_events >&2 || true
  if [ "$proposal_status" = Approved ]; then
    step "The oracle now shows"
    case "$method" in
      add_registered_key | remove_registered_key) view_on "$oracle" get_registered_keys '{}' ;;
      publish_prompt_template) view_on "$oracle" get_prompt_template '{}' ;;
      set_config | upgrade) view_on "$oracle" get_config '{}' ;;
      resolve_appeal) view_on "$oracle" get_assertion "{\"assertion_id\":$(json_field assertion_id <<<"$args")}" ;;
    esac
    echo
  fi
fi

printf '\nProposal %s on %s\n' "$proposal_id" "$dao"
print_links
