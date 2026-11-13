import {
  decodeFunctionResult,
  encodeEventTopics,
  encodeFunctionData,
  type Address,
  type Hex,
} from "viem";
import { RECEIVER_ABI } from "./relayer.ts";

/** Where an EVM Hook's delivery is read from. */
export interface EvmDeliveryOptions {
  /** JSON-RPC of the Hook's chain, e.g. `https://sepolia.base.org`. */
  rpcUrl: string;
  /**
   * An Etherscan-compatible `getLogs` API without a key (e.g. Blockscout's
   * `https://base-sepolia.blockscout.com/api`), to find the delivery
   * transaction. Public RPCs limit `eth_getLogs` to a few hundred blocks.
   */
  logsApiUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/** An EVM Hook's delivery as its Receiver records it. */
export interface EvmDelivery {
  /** `isDelivered(assertionId, consumer)`: the Receiver recorded the outcome for this Consumer. */
  delivered: boolean;
  /** `outcomeOf(assertionId)`: the outcome the Receiver holds for the Assertion, from any Consumer's delivery. */
  outcome: { recorded: boolean; truthful: boolean; claimHash: string; settledAt: string };
  /** The transaction that emitted `OutcomeRecorded` for this Consumer, if a logs API found it. */
  transactionHash: string | null;
}

/**
 * Reads an EVM Hook's delivery from its Receiver: `isDelivered` and
 * `outcomeOf` over JSON-RPC, then, once delivered, the `OutcomeRecorded`
 * log's transaction from the logs API. A failing logs API leaves the
 * transaction null; a failing RPC rejects.
 */
export async function fetchEvmDelivery(
  { rpcUrl, logsApiUrl, fetch = globalThis.fetch }: EvmDeliveryOptions,
  hook: { receiver: string; consumer: string; assertionId: number },
): Promise<EvmDelivery> {
  const receiver = hook.receiver as Address;
  const consumer = hook.consumer as Address;
  const assertionId = BigInt(hook.assertionId);
  const call = async (data: Hex): Promise<Hex> => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: receiver, data }, "latest"],
      }),
    });
    if (!response.ok) throw new Error(`eth_call: HTTP ${response.status}`);
    const body = (await response.json()) as { result?: Hex; error?: { message?: string } };
    if (body.error || !body.result)
      throw new Error(`eth_call: ${body.error?.message ?? "no result"}`);
    return body.result;
  };

  const isDelivered = { abi: RECEIVER_ABI, functionName: "isDelivered" } as const;
  const outcomeOf = { abi: RECEIVER_ABI, functionName: "outcomeOf" } as const;
  const [delivered, outcome] = await Promise.all([
    call(encodeFunctionData({ ...isDelivered, args: [assertionId, consumer] })).then((data) =>
      decodeFunctionResult({ ...isDelivered, data }),
    ),
    call(encodeFunctionData({ ...outcomeOf, args: [assertionId] })).then((data) =>
      decodeFunctionResult({ ...outcomeOf, data }),
    ),
  ]);

  return {
    delivered,
    outcome: {
      recorded: outcome.recorded,
      truthful: outcome.truthful,
      claimHash: outcome.claimHash,
      settledAt: outcome.settledAt.toString(),
    },
    transactionHash:
      delivered && logsApiUrl
        ? await deliveryTransaction(fetch, logsApiUrl, receiver, assertionId, consumer)
        : null,
  };
}

async function deliveryTransaction(
  fetch: typeof globalThis.fetch,
  logsApiUrl: string,
  receiver: Address,
  assertionId: bigint,
  consumer: Address,
): Promise<string | null> {
  const [topic0, topic1, topic2] = encodeEventTopics({
    abi: RECEIVER_ABI,
    eventName: "OutcomeRecorded",
    args: { assertionId, consumer },
  });
  const url = new URL(logsApiUrl);
  const query = {
    module: "logs",
    action: "getLogs",
    address: receiver,
    fromBlock: "0",
    toBlock: "latest",
    topic0: topic0!,
    topic1: topic1 as string,
    topic2: topic2 as string,
    topic0_1_opr: "and",
    topic1_2_opr: "and",
    topic0_2_opr: "and",
  };
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const body = (await response.json()) as {
      result?: Array<{ transactionHash?: string }> | string;
    };
    return Array.isArray(body.result) ? (body.result[0]?.transactionHash ?? null) : null;
  } catch {
    return null;
  }
}
