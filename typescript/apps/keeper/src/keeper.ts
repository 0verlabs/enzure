// One Keeper pass: the Scheduler, the Resolver and one Relayer per configured
// chain against the oracle. The decisions live in @enzure/core; this file
// wires them to near-kit, viem and the configuration. It runs unchanged in the
// Worker's Durable Object (worker.ts) and in the local Node loop (main.ts).
//
// It polls `list_assertions` instead of reading NEAR events, because there is
// no indexer: a dispute shows up as an Assertion in state `disputed`.

import {
  createResolver,
  dueCalls,
  listAssertions,
  relayOnce,
  type OracleAssertion,
  type OracleCall,
  type OracleView,
  type RelayerClients,
  type ResolverMemory,
} from "@enzure/core";
import { Near, type FinalExecutionOutcome } from "near-kit";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { KeeperConfig, RelayerConfig } from "./config.ts";

export type LogEntry = Record<string, unknown> & { event: string };
export type Log = (entry: LogEntry) => void;

/** JSON lines on stdout; Workers Logs indexes their fields. */
export const jsonLog: Log = (entry) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));

export interface Keeper {
  /** One pass over every Assertion. Failures are logged; only a failed listing rejects. */
  pass(): Promise<void>;
  /** What this Keeper runs against, for a start-up log line. */
  describe(): LogEntry;
}

export function createKeeper(
  config: KeeperConfig,
  { log = jsonLog, resolverMemory }: { log?: Log; resolverMemory?: ResolverMemory } = {},
): Keeper {
  const near = new Near({
    network: config.nearNetwork,
    ...(config.nearRpcUrl === undefined ? {} : { rpcUrl: config.nearRpcUrl }),
    privateKey: config.nearPrivateKey,
    defaultSignerId: config.nearAccountId,
    defaultWaitUntil: "EXECUTED_OPTIMISTIC",
  });
  const oracle = config.oracleAccountId;
  const explorer =
    config.nearNetwork === "testnet"
      ? "https://testnet.nearblocks.io/txns/"
      : "https://nearblocks.io/txns/";

  const view: OracleView = async <T>(method: string, args: Record<string, unknown>) =>
    (await near.view<T>(oracle, method, args, { finality: "optimistic" })) as T;

  const call: OracleCall = async (method, args, { gas, deposit }) => {
    const outcome = await near.call<FinalExecutionOutcome>(oracle, method, args, {
      gas: gas as `${number}`,
      attachedDeposit: BigInt(deposit),
    });
    // Log ids only: submit_ai_verdict's arguments carry the whole Claim and Evidence.
    log({
      event: "transaction",
      method,
      assertion_id: args.assertion_id,
      ...(args.hook_index === undefined ? {} : { hook_index: args.hook_index }),
      tx: `${explorer}${outcome.transaction?.hash}`,
    });
    return outcome;
  };

  const resolver = createResolver(
    {
      view,
      call,
      storageUrl: config.storageUrl,
      nearAiApiKey: config.nearAiApiKey,
      nearAiUrl: config.nearAiUrl,
    },
    resolverMemory === undefined ? {} : { memory: resolverMemory },
  );

  const relayers = config.relayers.map(relayer);

  /** The latest block's time, so timers are compared with the chain's clock, not ours. */
  async function chainTimeNs(): Promise<bigint> {
    const status = await near.getStatus();
    return BigInt(Date.parse(status.sync_info.latest_block_time)) * 1_000_000n;
  }

  return {
    async pass() {
      // One listing per pass, shared by the Scheduler, the Resolver and the Relayers.
      // A Hook signed during this pass is relayed on the next one.
      const assertions = await listAssertions<OracleAssertion>(view);

      // Scheduler: settle, check_timeout, sign_hook and retry_near_hook as soon as they are callable.
      const due = dueCalls(assertions, { nowNs: await chainTimeNs() });
      for (const { method, args, gas, deposit } of due) {
        try {
          await call(method, { ...args }, { gas, deposit });
        } catch (error) {
          log({ event: "scheduler_failed", method, ...args, error: String(error) });
        }
      }

      // Resolver: one AI Verdict per disputed Assertion.
      for (const result of await resolver.pass(assertions)) {
        log({ event: `resolver_${result.status}`, ...result });
      }

      // Relayers: deliver signed Hooks to their Receivers, one chain at a time.
      // A chain whose RPC is down or misconfigured doesn't stop the others.
      for (const { chain, clients } of relayers) {
        try {
          for (const { hook, result } of await relayOnce(view, await clients(), { assertions })) {
            log({ event: `relayer_${result.status}`, chain, ...hook, ...result });
          }
        } catch (error) {
          log({ event: "relayer_chain_failed", chain, error: String(error) });
        }
      }
    },
    describe() {
      return {
        event: "started",
        oracle,
        signer: config.nearAccountId,
        network: config.nearNetwork,
        storage: config.storageUrl,
        relayers: config.relayers.map(({ chain }) => chain),
        poll_interval_ms: config.pollIntervalMs,
      };
    },
  };
}

/**
 * The clients for one Relayer chain, made on first use and kept once its RPC
 * has reported one of the chain's ids. Only EVM chains exist so far; a new
 * kind of chain gets its own branch here and its own relayer in core.
 */
function relayer(config: RelayerConfig) {
  let ready: Promise<RelayerClients> | undefined;
  return {
    chain: config.chain,
    clients: (): Promise<RelayerClients> => {
      ready ??= evmRelayerClients(config).catch((error: unknown) => {
        ready = undefined; // try again next pass
        throw error;
      });
      return ready;
    },
  };
}

async function evmRelayerClients({
  chain: name,
  chainIds,
  rpcUrl,
  privateKey,
}: RelayerConfig): Promise<RelayerClients> {
  const transport = http(rpcUrl);
  const chainId = await createPublicClient({ transport }).getChainId();
  if (!chainIds.includes(chainId)) {
    throw new Error(`${name}_RPC_URL reports chain ${chainId}, not one of ${chainIds.join(", ")}`);
  }
  const chain = defineChain({
    id: chainId,
    name: `${name} (${chainId})`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  return {
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({
      account: privateKeyToAccount(privateKey),
      chain,
      transport,
    }),
  };
}
