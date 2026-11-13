// Runs one Relayer pass: reads the oracle's Assertions on NEAR, and delivers
// every signed EVM Hook for the EVM chain at EVM_RPC_URL to its Receiver,
// skipping results the Receiver already recorded. The Keeper service runs the
// same core function (`relayOnce`) in a loop.
//
//   node scripts/relay-evm-hooks.mts <oracle-account-id>
//
// Environment (or the repository's .env, loaded with --env-file-if-exists=.env):
//   EVM_PRIVATE_KEY  the Relayer's key, 0x and 64 hex characters; it pays the gas
//   EVM_RPC_URL      EVM JSON-RPC endpoint (https://sepolia.base.org)
//   NEAR_RPC_URL     NEAR RPC (https://rpc.testnet.near.org)
//
// Prints one line per Hook and exits non-zero if any delivery failed.

import { createRequire } from "node:module";
import {
  nearRpcView,
  relayOnce,
  type RelayerClients,
} from "../typescript/packages/core/src/index.ts";

// viem is a dependency of the core package; load it from there.
const require = createRequire(new URL("../typescript/packages/core/package.json", import.meta.url));
const viem = require("viem") as typeof import("viem");
const { privateKeyToAccount } = require("viem/accounts") as typeof import("viem/accounts");

const oracle = process.argv[2];
if (!oracle) {
  console.error("usage: node scripts/relay-evm-hooks.mts <oracle-account-id>");
  process.exit(2);
}
const privateKey = process.env.EVM_PRIVATE_KEY;
if (!privateKey?.match(/^0x[0-9a-fA-F]{64}$/)) {
  console.error("Set EVM_PRIVATE_KEY to the Relayer's key (0x and 64 hex characters)");
  process.exit(2);
}
const evmRpc = process.env.EVM_RPC_URL ?? "https://sepolia.base.org";
const nearRpc = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";

const view = nearRpcView({ rpcUrl: nearRpc, contractId: oracle });

const transport = viem.http(evmRpc);
const chainId = await viem.createPublicClient({ transport }).getChainId();
const chain = viem.defineChain({
  id: chainId,
  name: `chain ${chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [evmRpc] } },
});
const clients: RelayerClients = {
  publicClient: viem.createPublicClient({ chain, transport }),
  walletClient: viem.createWalletClient({
    account: privateKeyToAccount(privateKey as `0x${string}`),
    chain,
    transport,
  }),
};
const explorer = chainId === 84532 ? "https://sepolia.basescan.org/tx/" : "";

const results = await relayOnce(view, clients);
if (results.length === 0) console.log(`No signed EVM Hooks for chain ${chainId} on ${oracle}`);
let failed = false;
for (const { hook, result } of results) {
  const where = `Assertion ${hook.assertionId} Hook ${hook.hookIndex} -> ${hook.receiver} (Consumer ${hook.consumer})`;
  const hash = "transactionHash" in result ? ` ${explorer}${result.transactionHash}` : "";
  const detail = "reason" in result ? `: ${result.reason}` : "error" in result ? `: ${result.error}` : "";
  console.log(`${where}: ${result.status}${detail}${hash}`);
  if (result.status !== "delivered" && result.status !== "already_delivered") failed = true;
}
process.exit(failed ? 1 : 0);
