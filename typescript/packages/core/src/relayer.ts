import { sha256 } from "@noble/hashes/sha2.js";
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
  if (signed.asserter_hash !== `0x${bytesToHex(sha256(new TextEncoder().encode(signed.asserter)))}`) {
    return { ok: false, reason: "asserter_hash does not match asserter" };
  }
  let signer: string;
  try {
    signer = recoverEvmSigner(resultMessageDigest(resultMessageOf(signed)), signed);
  } catch {
    return { ok: false, reason: "invalid signature" };
  }
  if (signer !== oracleAddress.toLowerCase()) return { ok: false, reason: "not signed by the oracle" };
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
