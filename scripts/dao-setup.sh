#!/usr/bin/env bash
# Creates the oracle's Sputnik DAO on NEAR testnet and deploys the oracle with
# that DAO as its DAO account and treasury (ADR 0004).
#
# The DAO is created through the Sputnik DAO v2 factory with one role,
# `council`, whose members can propose, vote and finalize every proposal kind.
# A proposal passes on APPROVALS council votes (1 by default), so the council
# can approve quickly for the demo. Only council members can file proposals.
#
# The oracle goes to a new account `oracle-<timestamp>.<NEAR_ACCOUNT_ID>` (or
# ORACLE_ACCOUNT_ID) with NEAR_PRIVATE_KEY as its full-access key. Remove that
# key with `scripts/oracle-lockdown.sh` once the DAO works.
#
# Needs near (near-cli-rs), cargo-near and node (see docs/toolchain.md), and in
# the environment or the repository's .env:
#   NEAR_ACCOUNT_ID    a funded testnet account; it pays for the DAO and the oracle account
#   NEAR_PRIVATE_KEY   a full-access key of NEAR_ACCOUNT_ID (ed25519:...)
# Optional:
#   COUNCIL            council account ids, comma separated (NEAR_ACCOUNT_ID)
#   APPROVALS          council votes a proposal needs (1)
#   DAO_NAME           the DAO is <DAO_NAME>.<DAO_FACTORY> (enzure-<timestamp>)
#   DAO_FACTORY        Sputnik DAO v2 factory (sputnikv2.testnet)
#   DAO_DEPOSIT        NEAR for the DAO account; its code needs about 5.5 ("6 NEAR")
#   PROPOSAL_BOND      yoctoNEAR bond per proposal, returned when it passes (0.1 NEAR)
#   PROPOSAL_PERIOD    seconds a proposal stays open for votes (604800)
#   ORACLE_ACCOUNT_ID  deploy to this account instead; it must exist with NEAR_PRIVATE_KEY
#                      as a full-access key and no contract yet
#   ORACLE_BALANCE     NEAR given to a new oracle account ("3.5 NEAR")
#   ORACLE_WASM        deploy this build instead of building the oracle
#
# Needs about 9.6 testnet NEAR with the defaults.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/near.sh
source "$root/scripts/lib/near.sh"
# shellcheck source=scripts/lib/dao.sh
source "$root/scripts/lib/dao.sh"

load_env "$root" NEAR_ACCOUNT_ID NEAR_PRIVATE_KEY
require_tools near node
: "${NEAR_ACCOUNT_ID:?Set NEAR_ACCOUNT_ID to a funded testnet account}"
: "${NEAR_PRIVATE_KEY:?Set NEAR_PRIVATE_KEY to a full-access key of NEAR_ACCOUNT_ID}"
export NEAR_PRIVATE_KEY
now="$(date +%s)"
council="${COUNCIL:-$NEAR_ACCOUNT_ID}"
approvals="${APPROVALS:-1}"
dao_name="${DAO_NAME:-enzure-$now}"
dao="$dao_name.$DAO_FACTORY"
dao_deposit="${DAO_DEPOSIT:-6 NEAR}"
proposal_bond="${PROPOSAL_BOND:-100000000000000000000000}"
proposal_period="${PROPOSAL_PERIOD:-604800}"
oracle_balance="${ORACLE_BALANCE:-3.5 NEAR}"
case "$approvals" in '' | *[!0-9]* | 0) die "APPROVALS must be a positive number" ;; esac

near_keys_init
signer_key="$(near_key_file "$NEAR_ACCOUNT_ID")"

step "Creating the Sputnik DAO $dao (council: $council; $approvals vote(s) pass a proposal)"
create_args="$(node -e '
  const [name, council, approvals, bond, period] = process.argv.slice(1);
  const members = council.split(",").map((m) => m.trim()).filter(Boolean);
  if (members.length === 0) throw new Error("COUNCIL is empty");
  if (Number(approvals) > members.length) throw new Error("APPROVALS is larger than the council");
  const policy = {
    roles: [{
      name: "council",
      kind: { Group: members },
      permissions: ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
      vote_policy: {},
    }],
    // A weight threshold counts council votes: `approvals` of them pass a proposal.
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: approvals },
    proposal_bond: bond,
    proposal_period: (BigInt(period) * 1_000_000_000n).toString(),
    bounty_bond: bond,
    bounty_forgiveness_period: "86400000000000",
  };
  const config = {
    name,
    purpose: "Governs the Enzure oracle: Registered Keys, Prompt Templates, config, Appeal rulings and upgrades.",
    metadata: "",
  };
  const args = Buffer.from(JSON.stringify({ config, policy })).toString("base64");
  console.log(JSON.stringify({ name, args }));' "$dao_name" "$council" "$approvals" "$proposal_bond" "$proposal_period")"
send "create DAO" contract call-function as-transaction "$DAO_FACTORY" create json-args "$create_args" \
  prepaid-gas '300 Tgas' attached-deposit "$dao_deposit" sign-as "$NEAR_ACCOUNT_ID" \
  network-config "$NEAR_NETWORK" sign-with-access-key-file "$signer_key" send
policy="$(view_on "$dao" get_policy '{}')" || die "the factory did not create $dao (see the transaction above)"
echo "Policy: $policy" >&2

if [ -n "${ORACLE_WASM:-}" ]; then
  wasm="$ORACLE_WASM"
else
  require_tools cargo
  step "Building the oracle"
  (cd "$root/contracts/near/oracle" && cargo near build non-reproducible-wasm --locked >&2)
  wasm="$root/contracts/near/target/near/oracle/oracle.wasm"
fi

if [ -n "${ORACLE_ACCOUNT_ID:-}" ]; then
  oracle="$ORACLE_ACCOUNT_ID"
else
  oracle="oracle-$now.$NEAR_ACCOUNT_ID"
  step "Creating the oracle account $oracle"
  send "create oracle account" account create-account fund-myself "$oracle" "$oracle_balance" \
    use-manually-provided-public-key "$NEAR_PUBLIC_KEY" sign-as "$NEAR_ACCOUNT_ID" \
    network-config "$NEAR_NETWORK" sign-with-access-key-file "$signer_key" send
fi

step "Deploying the oracle to $oracle with $dao as its DAO and treasury"
send "deploy oracle" contract deploy "$oracle" use-file "$wasm" with-init-call new \
  json-args "{\"dao\":\"$dao\"}" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  network-config "$NEAR_NETWORK" sign-with-access-key-file "$(near_key_file "$oracle")" send
config="$(view_on "$oracle" get_config '{}')"
[ "$(json_field dao <<<"$config")" = "$dao" ] || die "the oracle's DAO is not $dao: $config"

printf '\nDAO: %s\nOracle: %s\nConfig: %s\n' "$dao" "$oracle" "$config"
print_links
printf '\nNext: file proposals with scripts/dao-propose.sh %s %s <kind> ...,\nthen run scripts/oracle-lockdown.sh %s\n' \
  "$dao" "$oracle" "$oracle"
