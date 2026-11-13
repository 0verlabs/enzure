#!/usr/bin/env bash
# Deploys the Receiver for one oracle to Base Sepolia (or any EVM chain) and
# records it in contracts/evm/deployments/<chain id>.json. With
# --with-example-consumer it also deploys examples/evm-consumer for that Receiver.
#
#   ./scripts/deploy-receiver.sh <oracle-account-id> [--with-example-consumer]
#
# Reads the oracle's derived EVM address from NEAR testnet with
# scripts/oracle-evm-address.mts, so the oracle must already be deployed.
# Set ORACLE_EVM_ADDRESS to skip that lookup.
#
# Needs forge and node (see docs/toolchain.md), and in the environment or the
# repository's .env:
#   EVM_PRIVATE_KEY   deployer key, 0x and 64 hex characters, funded with Base Sepolia ETH
# Optional:
#   EVM_RPC_URL       JSON-RPC endpoint (https://sepolia.base.org)
#   NEAR_RPC_URL      NEAR RPC for the address lookup (https://rpc.testnet.near.org)
#
# The key is passed to forge through the environment, never on the command line.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/near.sh
source "$root/scripts/lib/near.sh"

oracle="${1:-}"
with_consumer=false
case "${2:-}" in
  --with-example-consumer) with_consumer=true ;;
  '') ;;
  *) oracle="" ;;
esac
if [ -z "$oracle" ]; then
  echo "usage: $0 <oracle-account-id> [--with-example-consumer]" >&2
  exit 2
fi

load_env "$root" EVM_PRIVATE_KEY EVM_RPC_URL NEAR_RPC_URL
for tool in forge cast node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' not found, see docs/toolchain.md" >&2; exit 1; }
done
: "${EVM_PRIVATE_KEY:?Set EVM_PRIVATE_KEY to a funded deployer key}"
rpc="${EVM_RPC_URL:-https://sepolia.base.org}"
near_rpc="${NEAR_RPC_URL:-https://rpc.testnet.near.org}"
chain_id="$(cast chain-id --rpc-url "$rpc")"

if [ -z "${ORACLE_EVM_ADDRESS:-}" ]; then
  ORACLE_EVM_ADDRESS="$(node "$root/scripts/oracle-evm-address.mts" "$oracle" --rpc "$near_rpc" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).address))')"
fi
echo "Oracle $oracle signs EVM Hooks as $ORACLE_EVM_ADDRESS; deploying its Receiver to chain $chain_id" >&2
export EVM_PRIVATE_KEY ORACLE_EVM_ADDRESS ORACLE_ACCOUNT_ID="$oracle"

(cd "$root/contracts/evm" && forge script script/DeployReceiver.s.sol:DeployReceiver \
  --rpc-url "$rpc" --broadcast >&2)
record="$root/contracts/evm/deployments/${chain_id}.json"
receiver="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).receiver)' "$record")"
echo "Receiver: $receiver (recorded in ${record#"$root"/})" >&2

if [ "$with_consumer" = true ]; then
  export RECEIVER_ADDRESS="$receiver"
  output="$(cd "$root/examples/evm-consumer" && forge script script/DeployExampleConsumer.s.sol:DeployExampleConsumer \
    --rpc-url "$rpc" --broadcast 2>&1)" || { printf '%s\n' "$output" >&2; exit 1; }
  printf '%s\n' "$output" >&2
  consumer="$(sed -n 's/.*ExampleConsumer \(0x[0-9a-fA-F]\{40\}\) for Receiver.*/\1/p' <<<"$output" | head -n 1)"
  echo "Example Consumer: $consumer" >&2
fi

printf '{"oracle":"%s","oracle_evm_address":"%s","chain_id":%s,"receiver":"%s","example_consumer":"%s"}\n' \
  "$oracle" "$ORACLE_EVM_ADDRESS" "$chain_id" "$receiver" "${consumer:-}"
