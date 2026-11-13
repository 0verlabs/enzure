#!/usr/bin/env bash
# Votes for a Sputnik DAO proposal as a council member and reports the result.
#
#   scripts/dao-approve.sh <dao> <proposal-id>
#
# Prints the proposal first (its description and the call it makes), then votes
# VoteApprove. When the vote passes the proposal, the DAO makes the call at
# once; the script prints the events the call logged and exits non-zero if the
# call failed (the proposal is then `Failed` and can be finalized again).
#
# Needs near (near-cli-rs) and node, and in the environment or the .env:
#   NEAR_ACCOUNT_ID    a council member of the DAO
#   NEAR_PRIVATE_KEY   a full-access key of NEAR_ACCOUNT_ID (ed25519:...)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/near.sh
source "$root/scripts/lib/near.sh"
# shellcheck source=scripts/lib/dao.sh
source "$root/scripts/lib/dao.sh"

[ "$#" -eq 2 ] || { sed -n '4p' "$0" | sed 's/^# //' >&2; exit 2; }
dao="$1" id="$2"
case "$id" in '' | *[!0-9]*) die "the proposal id must be a number" ;; esac

load_env "$root" NEAR_ACCOUNT_ID NEAR_PRIVATE_KEY
require_tools near node
: "${NEAR_ACCOUNT_ID:?Set NEAR_ACCOUNT_ID to a council member of the DAO}"
: "${NEAR_PRIVATE_KEY:?Set NEAR_PRIVATE_KEY to a full-access key of NEAR_ACCOUNT_ID}"
export NEAR_PRIVATE_KEY
near_keys_init

step "Proposal $id on $dao"
view_on "$dao" get_proposal "{\"id\":$id}" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const p = JSON.parse(s);
    console.error(`proposer:    ${p.proposer}\nstatus:      ${p.status}\ndescription: ${p.description}`);
    for (const [kind, body] of Object.entries(typeof p.kind === "string" ? { [p.kind]: {} } : p.kind)) {
      if (kind !== "FunctionCall") { console.error(`kind:        ${kind} ${JSON.stringify(body)}`); continue; }
      for (const a of body.actions) {
        const bytes = Buffer.from(a.args, "base64");
        const shown = a.method_name === "upgrade"
          ? `<${bytes.length} bytes of code, sha256 ${require("crypto").createHash("sha256").update(bytes).digest("hex")}>`
          : bytes.toString("utf8");
        console.error(`call:        ${body.receiver_id}.${a.method_name}(${shown}) deposit ${a.deposit} gas ${a.gas}`);
      }
    }
  });'

step "Voting for proposal $id as $NEAR_ACCOUNT_ID"
status=0
dao_approve "$dao" "$id" || status=$?
last_events >&2 || true
print_links
[ "$status" -eq 0 ] || die "proposal $id was approved but its call failed"
