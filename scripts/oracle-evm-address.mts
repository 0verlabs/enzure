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
import { evmAddressFromPublicKey } from "../typescript/packages/core/src/index.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { rpc: { type: "string", default: "https://rpc.testnet.near.org" } },
});
const oracle = positionals[0];
if (!oracle) {
  console.error("usage: node scripts/oracle-evm-address.mts <oracle-account-id> [--rpc <url>]");
  process.exit(2);
}

async function view<T>(accountId: string, method: string, args: unknown): Promise<T> {
  const response = await fetch(values.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "enzure",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: accountId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const body = (await response.json()) as {
    result?: { result?: number[]; error?: string };
    error?: unknown;
  };
  if (!body.result?.result) {
    throw new Error(`${accountId}.${method} failed: ${JSON.stringify(body.error ?? body.result)}`);
  }
  return JSON.parse(Buffer.from(body.result.result).toString("utf8")) as T;
}

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
