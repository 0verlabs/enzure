import { sha256 } from "@noble/hashes/sha2.js";
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from "viem";
import { bytesToHex } from "./signature.ts";
import { recoverEvmSigner, resultMessageDigest, type ResultMessage } from "./result-message.ts";

/** A signed result as the oracle's `get_signed_result` view returns it. Byte fields are `0x` lowercase hex. */
export interface SignedResultView {
  version: string;
  chain_id: number;
  receiver: string;
  consumer: string;
  assertion_id: number;
  outcome: boolean;
  claim_hash: string;
  /** The Asserter's NEAR account id. */
  asserter: string;
  /** sha256 of `asserter`. */
  asserter_hash: string;
  /** Settlement time, Unix seconds, as a decimal string. */
  settled_at: string;
  message: string;
  digest: string;
  r: string;
  s: string;
  /** 27 or 28. */
  v: number;
}

export type SignedResultCheck = { ok: true } | { ok: false; reason: string };

/** An Assertion as the oracle's `get_assertion` and `list_assertions` views return it; only what the Scheduler and Relayer read. */
export interface AssertionView {
  id: number;
  /** `settled` once the outcome is final; other values are earlier states. */
  state: string;
  hooks: readonly HookView[];
}

/** A Hook in an Assertion view: `{ near: {...} }` or `{ evm: {...} }`. */
export type HookView =
  | { near: { consumer: string; gas: string; status: string } }
  | { evm: EvmHookView };

export interface EvmHookView {
  chain_id: number;
  receiver: string;
  consumer: string;
  status: "unsigned" | "signing" | "signed" | (string & {});
}

/** One EVM Hook of an Assertion, by its position in the Assertion's Hooks. */
export interface EvmHookRef {
  assertionId: number;
  hookIndex: number;
  chainId: number;
  receiver: string;
  consumer: string;
}

/**
 * The EVM Hooks the Scheduler should call `sign_hook` for: every `unsigned`
 * EVM Hook of a settled Assertion, including ones whose signing failed or
 * timed out. Hooks already `signing` are left alone.
 */
export function evmHooksToSign(assertions: readonly AssertionView[]): EvmHookRef[] {
  return evmHooksWithStatus(
    assertions.filter((assertion) => assertion.state === "settled"),
    "unsigned",
  );
}

/** The signed EVM Hooks for `chainId`, which the Relayer reads with `get_signed_result` and delivers. */
export function evmHooksToRelay(
  assertions: readonly AssertionView[],
  chainId: number,
): EvmHookRef[] {
  return evmHooksWithStatus(assertions, "signed").filter((hook) => hook.chainId === chainId);
}

function evmHooksWithStatus(assertions: readonly AssertionView[], status: string): EvmHookRef[] {
  return assertions.flatMap((assertion) =>
    assertion.hooks.flatMap((hook, hookIndex) =>
      "evm" in hook && hook.evm.status === status
        ? [
            {
              assertionId: assertion.id,
              hookIndex,
              chainId: hook.evm.chain_id,
              receiver: hook.evm.receiver,
              consumer: hook.evm.consumer,
            },
          ]
        : [],
    ),
  );
}

/**
 * Checks a signed result the way the Receiver will: rebuilds the result
 * message from its fields (ignoring the view's `message` and `digest`) and
 * recovers the signer, which must be `oracleAddress`, the oracle's derived EVM
 * address. A Relayer calls this before paying gas for `deliver`.
 */
export function checkSignedResult(
  signed: SignedResultView,
  oracleAddress: string,
): SignedResultCheck {
  if (
    signed.asserter_hash !== `0x${bytesToHex(sha256(new TextEncoder().encode(signed.asserter)))}`
  ) {
    return { ok: false, reason: "asserter_hash does not match asserter" };
  }
  let signer: string;
  try {
    signer = recoverEvmSigner(resultMessageDigest(resultMessageOf(signed)), signed);
  } catch {
    return { ok: false, reason: "invalid signature" };
  }
  if (signer !== oracleAddress.toLowerCase())
    return { ok: false, reason: "not signed by the oracle" };
  return { ok: true };
}

/** The result message a signed result's fields describe. */
export function resultMessageOf(signed: SignedResultView): ResultMessage {
  return {
    chainId: BigInt(signed.chain_id),
    receiver: signed.receiver,
    consumer: signed.consumer,
    assertionId: BigInt(signed.assertion_id),
    outcome: signed.outcome,
    claimHash: signed.claim_hash,
    asserter: signed.asserter,
    settledAt: BigInt(signed.settled_at),
  };
}

/** The Receiver's ABI: the methods and events a Relayer, Consumer or reader uses. */
export const RECEIVER_ABI = [
  {
    type: "function",
    name: "deliver",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "result",
        type: "tuple",
        components: [
          { name: "assertionId", type: "uint256" },
          { name: "consumer", type: "address" },
          { name: "outcome", type: "bool" },
          { name: "claimHash", type: "bytes32" },
          { name: "asserter", type: "bytes32" },
          { name: "settledAt", type: "uint256" },
        ],
      },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [{ name: "recorded", type: "bool" }],
  },
  {
    type: "function",
    name: "retryCallback",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assertionId", type: "uint256" },
      { name: "consumer", type: "address" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  {
    type: "function",
    name: "isDelivered",
    stateMutability: "view",
    inputs: [
      { name: "assertionId", type: "uint256" },
      { name: "consumer", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "outcomeOf",
    stateMutability: "view",
    inputs: [{ name: "assertionId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "recorded", type: "bool" },
          { name: "truthful", type: "bool" },
          { name: "claimHash", type: "bytes32" },
          { name: "asserter", type: "bytes32" },
          { name: "settledAt", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "oracle",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "event",
    name: "OutcomeRecorded",
    inputs: [
      { name: "assertionId", type: "uint256", indexed: true },
      { name: "consumer", type: "address", indexed: true },
      { name: "truthful", type: "bool", indexed: false },
      { name: "claimHash", type: "bytes32", indexed: false },
      { name: "asserter", type: "bytes32", indexed: false },
      { name: "settledAt", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ConsumerCalled",
    inputs: [
      { name: "assertionId", type: "uint256", indexed: true },
      { name: "consumer", type: "address", indexed: true },
      { name: "success", type: "bool", indexed: false },
    ],
  },
] as const;

/** The EVM side of the Relayer: a client to read the Receiver and a wallet with an account and chain to pay for `deliver`. */
export interface RelayerClients {
  /** Any viem public client works; only these methods are used. */
  publicClient: {
    getChainId(): Promise<number>;
    call(args: { to: Address; data: Hex }): Promise<{ data?: Hex | undefined }>;
    waitForTransactionReceipt(args: { hash: Hex }): Promise<{ status: "success" | "reverted" }>;
  };
  /** A viem wallet client with its account and chain set. */
  walletClient: { sendTransaction(args: { to: Address; data: Hex }): Promise<Hex> };
}

export type RelayResult =
  | { status: "delivered"; transactionHash: Hex }
  | { status: "already_delivered" }
  | { status: "rejected"; reason: string }
  | { status: "reverted"; transactionHash: Hex };

/**
 * Delivers one signed result to its Receiver, unless the Receiver already
 * recorded it for this Consumer or would reject it (another chain, or not
 * signed by the Receiver's oracle). Waits for the transaction's receipt.
 */
export async function relaySignedResult(
  { publicClient, walletClient }: RelayerClients,
  signed: SignedResultView,
): Promise<RelayResult> {
  const chainId = await publicClient.getChainId();
  if (chainId !== signed.chain_id) {
    return {
      status: "rejected",
      reason: `signed for chain ${signed.chain_id}, not chain ${chainId}`,
    };
  }
  const receiver = signed.receiver as Address;
  const isDelivered = { abi: RECEIVER_ABI, functionName: "isDelivered" } as const;
  const delivered = decodeFunctionResult({
    ...isDelivered,
    data: await callReceiver(
      publicClient,
      receiver,
      encodeFunctionData({
        ...isDelivered,
        args: [BigInt(signed.assertion_id), signed.consumer as Address],
      }),
    ),
  });
  if (delivered) return { status: "already_delivered" };
  const oracleOf = { abi: RECEIVER_ABI, functionName: "oracle" } as const;
  const oracle = decodeFunctionResult({
    ...oracleOf,
    data: await callReceiver(publicClient, receiver, encodeFunctionData(oracleOf)),
  });
  const check = checkSignedResult(signed, oracle);
  if (!check.ok) return { status: "rejected", reason: check.reason };

  const transactionHash = await walletClient.sendTransaction({
    to: receiver,
    data: encodeFunctionData({
      abi: RECEIVER_ABI,
      functionName: "deliver",
      args: deliverArgs(signed),
    }),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
  return receipt.status === "success"
    ? { status: "delivered", transactionHash }
    : { status: "reverted", transactionHash };
}

/** Calls a view method of the Receiver and returns its raw result. */
async function callReceiver(
  client: RelayerClients["publicClient"],
  receiver: Address,
  data: Hex,
): Promise<Hex> {
  const { data: result } = await client.call({ to: receiver, data });
  if (result === undefined) throw new Error(`Receiver ${receiver} returned nothing`);
  return result;
}

/** The Receiver's `deliver` arguments for a signed result. */
export function deliverArgs(signed: SignedResultView) {
  return [
    {
      assertionId: BigInt(signed.assertion_id),
      consumer: signed.consumer as Address,
      outcome: signed.outcome,
      claimHash: signed.claim_hash as Hex,
      asserter: signed.asserter_hash as Hex,
      settledAt: BigInt(signed.settled_at),
    },
    signed.v,
    signed.r as Hex,
    signed.s as Hex,
  ] as const;
}
