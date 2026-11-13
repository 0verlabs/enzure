// Prints the EVM address a deployed oracle signs EVM Hooks with.
//
// Reads the signer, derivation path and domain from the oracle's
// `get_evm_signer` view, asks that signer for the key it derives for the
// oracle's account (`derived_public_key`), and turns the key into an EVM
// address. A Receiver on any EVM chain is configured with this address.
//
//   node scripts/oracle-evm-address.mts <oracle-account-id> [--rpc <url>]
//
// Prints JSON: oracle, signer, path, domain_id, public_key, address. Needs only
// network access; the RPC defaults to NEAR testnet.

import { parseArgs } from "node:util";
import { evmAddressFromPublicKey, nearRpcView } from "../typescript/packages/core/src/index.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { rpc: { type: "string", default: "https://rpc.testnet.near.org" } },
});
const oracle = positionals[0];
if (!oracle) {
  console.error("usage: node scripts/oracle-evm-address.mts <oracle-account-id> [--rpc <url>]");
  process.exit(2);
}

/** A view call on any account through core's NEAR RPC reader. */
const view = <T,>(accountId: string, method: string, args: Record<string, unknown>) =>
  nearRpcView({ rpcUrl: values.rpc, contractId: accountId })<T>(method, args);

const { signer, path, domain_id } = await view<{
  signer: string;
  path: string;
  domain_id: number;
}>(oracle, "get_evm_signer", {});
const publicKey = await view<string>(signer, "derived_public_key", {
  path,
  predecessor: oracle,
  domain_id,
});

console.log(
  JSON.stringify(
    {
      oracle,
      signer,
      path,
      domain_id,
      public_key: publicKey,
      address: evmAddressFromPublicKey(publicKey),
    },
    null,
    2,
  ),
);
