// The Keeper service: one long-lived Node process that runs the Scheduler,
// the Resolver and (when EVM settings are given) the Relayer against the
// oracle, one pass every POLL_INTERVAL_MS. The decisions live in
// @enzure/core; this file supplies configuration, keys and the loop.
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
} from "@enzure/core";
import { Near, type FinalExecutionOutcome } from "near-kit";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "./config.ts";

type Log = Record<string, unknown> & { event: string };
const log = (entry: Log) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

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

const resolver = createResolver({
  view,
  call,
  storageUrl: config.storageUrl,
  nearAiApiKey: config.nearAiApiKey,
  nearAiUrl: config.nearAiUrl,
});

const relayer = config.relayer && (await relayerClients(config.relayer));

async function relayerClients({
  evmRpcUrl,
  evmPrivateKey,
}: NonNullable<typeof config.relayer>): Promise<RelayerClients> {
  const transport = http(evmRpcUrl);
  const chainId = await createPublicClient({ transport }).getChainId();
  const chain = defineChain({
    id: chainId,
    name: `chain ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [evmRpcUrl] } },
  });
  return {
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({
      account: privateKeyToAccount(evmPrivateKey),
      chain,
      transport,
    }),
  };
}

/** The latest block's time, so timers are compared with the chain's clock, not ours. */
async function chainTimeNs(): Promise<bigint> {
  const status = await near.getStatus();
  return BigInt(Date.parse(status.sync_info.latest_block_time)) * 1_000_000n;
}

async function pass(): Promise<void> {
  const assertions = await listAssertions<OracleAssertion>(view);

  // Scheduler: settle, check_timeout and sign_hook as soon as they are callable.
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

  // Relayer: deliver signed EVM Hooks to their Receivers.
  if (relayer) {
    for (const { hook, result } of await relayOnce(view, relayer)) {
      log({ event: `relayer_${result.status}`, ...hook, ...result });
    }
  }
}

let stopping = false;
let wake: (() => void) | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log({ event: "stopping", signal });
    stopping = true;
    wake?.();
  });
}

log({
  event: "started",
  oracle,
  signer: config.nearAccountId,
  network: config.nearNetwork,
  storage: config.storageUrl,
  relayer: relayer ? await relayer.publicClient.getChainId() : null,
  poll_interval_ms: config.pollIntervalMs,
});
while (!stopping) {
  const started = Date.now();
  try {
    await pass();
  } catch (error) {
    log({ event: "pass_failed", error: String(error) });
  }
  const wait = Math.max(0, config.pollIntervalMs - (Date.now() - started));
  await new Promise<void>((resolve) => {
    wake = resolve;
    setTimeout(resolve, wait);
  });
}
log({ event: "stopped" });
