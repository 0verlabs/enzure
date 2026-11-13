// Wiring shared by the buyer script and the seller agent: environment,
// clients and the escrow's ABI. The business logic (storage, hashes, oracle
// reads) comes from @enzure/core, imported from source like scripts/*.mts.

import { createRequire } from "node:module";
import type { FinalExecutionOutcome } from "near-kit";
import { sha256Hex } from "../../../typescript/packages/core/src/index.ts";

// viem is a dependency of the core package and near-kit of the Keeper; load them from there.
const fromCore = createRequire(new URL("../../../typescript/packages/core/package.json", import.meta.url));
const fromKeeper = createRequire(new URL("../../../typescript/apps/keeper/package.json", import.meta.url));
export const viem = fromCore("viem") as typeof import("viem");
const { privateKeyToAccount } = fromCore("viem/accounts") as typeof import("viem/accounts");
const { Near } = fromKeeper("near-kit") as typeof import("near-kit");

export type Hex = `0x${string}`;

export const ESCROW_ABI = viem.parseAbi([
  "function token() view returns (address)",
  "function receiver() view returns (address)",
  "function nextJobId() view returns (uint256)",
  "function createJob(uint256 jobId, uint256 amount, address seller, bytes32 sellerNear, bytes32 claimHash, uint64 deadline)",
  "function reclaim(uint256 jobId)",
  "function getJob(uint256 jobId) view returns ((address buyer, address seller, uint256 amount, bytes32 sellerNear, bytes32 claimHash, uint64 deadline, uint8 status, uint256 assertionId))",
  "error WrongJobId(uint256 expected)",
  "error ClaimInUse()",
  "error InvalidJob()",
  "error NotFunded()",
  "error NotBuyer()",
  "error DeadlineNotPassed()",
  "error TransferFailed()",
]);

export const ERC20_ABI = viem.parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

/** The escrow's `Status` enum, by value. */
export const JOB_STATUS = ["none", "funded", "paid", "refunded", "reclaimed"] as const;

export const DEFAULT_STORAGE_URL = "https://enzure-storage.luckzivanius.workers.dev";

export function env(name: string): string {
  const value = process.env[name];
  if (!value) fail(`Set ${name} (see examples/escrow/README.md)`);
  return value;
}

export function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Runs a script's body and prints an error's short message instead of a stack. */
export async function run(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    const { shortMessage, metaMessages, message } = error as {
      shortMessage?: string;
      metaMessages?: string[];
      message: string;
    };
    fail([shortMessage ?? message, ...(metaMessages?.slice(0, 2) ?? [])].join("\n"));
  }
}

export function storage() {
  return { storageUrl: process.env.STORAGE_URL || DEFAULT_STORAGE_URL };
}

/** `0x` + sha256 of a NEAR account id, as the escrow and the result message carry it. */
export async function nearAccountHash(accountId: string): Promise<Hex> {
  return `0x${await sha256Hex(new TextEncoder().encode(accountId))}`;
}

/** Clients for the EVM chain at EVM_RPC_URL; a wallet only if `privateKey` is given. */
export async function evm(privateKey?: string) {
  const rpcUrl = process.env.EVM_RPC_URL || "https://sepolia.base.org";
  const transport = viem.http(rpcUrl);
  const chainId = await viem.createPublicClient({ transport }).getChainId();
  const chain = viem.defineChain({
    id: chainId,
    name: `chain ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = viem.createPublicClient({ chain, transport });
  if (privateKey !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    fail("EVM_PRIVATE_KEY must be 0x and 64 hex characters");
  }
  const walletClient =
    privateKey === undefined
      ? undefined
      : viem.createWalletClient({ account: privateKeyToAccount(privateKey as Hex), chain, transport });
  return { chainId, publicClient, walletClient };
}

/** A link to an EVM transaction: Basescan on Base Sepolia, or EVM_EXPLORER_TX + hash. */
export function evmTxLink(chainId: number, hash: string): string {
  const explorer =
    process.env.EVM_EXPLORER_TX ?? (chainId === 84532 ? "https://sepolia.basescan.org/tx/" : "");
  return `${explorer}${hash}`;
}

export function escrowAddress(): Hex {
  const address = env("ESCROW_ADDRESS");
  if (!viem.isAddress(address)) fail("ESCROW_ADDRESS is not an EVM address");
  return address.toLowerCase() as Hex;
}

/** A near-kit client signing as `accountId`; the key comes from the environment. */
export function near(accountId: string, privateKey: string) {
  const network = (process.env.NEAR_NETWORK as "testnet" | "mainnet" | undefined) ?? "testnet";
  const client = new Near({
    network,
    ...(process.env.NEAR_RPC_URL ? { rpcUrl: process.env.NEAR_RPC_URL } : {}),
    privateKey: privateKey as `ed25519:${string}`,
    defaultSignerId: accountId,
    defaultWaitUntil: "EXECUTED_OPTIMISTIC",
  });
  const explorer =
    network === "testnet" ? "https://testnet.nearblocks.io/txns/" : "https://nearblocks.io/txns/";
  return {
    client,
    /** Calls `method` on the oracle and returns the decoded return value and a NearBlocks link. */
    async call<T>(oracle: string, method: string, args: object, deposit: bigint, gas = "100 Tgas") {
      const outcome = await client.call<FinalExecutionOutcome>(oracle, method, args, {
        gas: gas as `${number} Tgas`,
        attachedDeposit: deposit,
      });
      const status = outcome.status as { SuccessValue?: string } | string;
      const encoded = typeof status === "object" ? status.SuccessValue : undefined;
      const value =
        encoded === undefined || encoded === ""
          ? undefined
          : (JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as T);
      return { value, tx: `${explorer}${outcome.transaction.hash}` };
    },
    view<T>(oracle: string, method: string, args: object = {}) {
      // Optimistic, so an Assertion this script just posted is already visible.
      return client.view<T>(oracle, method, args, { finality: "optimistic" }) as Promise<T>;
    },
  };
}
