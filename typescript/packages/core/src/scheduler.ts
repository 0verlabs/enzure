import {
  SIGN_HOOK_DEPOSIT_YOCTO,
  SIGN_HOOK_GAS,
  evmHooksToSign,
  type AssertionView,
} from "./relayer.ts";

/** A dispute as the oracle's Assertion views return it. */
export interface DisputeView {
  disputer: string;
  /** sha256 of the Disputer's Evidence, lowercase hex, or null if none. */
  evidence_hash: string | null;
  seed: number;
  disputed_at_ns: string;
}

/** An accepted AI Verdict as the oracle's Assertion views return it. */
export interface AiVerdictView {
  verdict: "TRUE" | "FALSE" | "UNRESOLVABLE" | (string & {});
  request_hash: string;
  response_hash: string;
  public_key: string;
  accepted_at_ns: string;
}

/**
 * An Assertion as `get_assertion` and `list_assertions` return it, with
 * everything the Scheduler and Resolver read. Timestamps are nanoseconds
 * since the Unix epoch, as decimal strings.
 */
export interface OracleAssertion extends AssertionView {
  asserter: string;
  claim_hash: string;
  evidence_hash: string | null;
  bond: string;
  asserted_at_ns: string;
  liveness_ends_at_ns: string;
  settled_at_ns: string | null;
  outcome: boolean | null;
  prompt_template_version: number | null;
  dispute: DisputeView | null;
  ai_verdicts: readonly AiVerdictView[];
  appeal_window_ends_at_ns: string | null;
}

/** A permissionless oracle call that is due now, with the gas (yoctoNEAR deposit) to attach. */
export interface DueCall {
  method: "settle" | "check_timeout" | "sign_hook";
  args: { assertion_id: number; hook_index?: number };
  gas: string;
  deposit: string;
}

/** Gas for `settle` and `check_timeout`: `settle` must also have room to start the NEAR Hooks. */
export const SCHEDULER_GAS = "300000000000000";

export interface DueCallOptions {
  /** The current time, in nanoseconds since the Unix epoch. */
  nowNs: bigint;
  /**
   * The oracle's AI Verdict deadline in seconds. Leave it undefined while the
   * deployed oracle has no `check_timeout`; no timeouts are then due.
   */
  aiVerdictDeadlineSecs?: number;
}

/**
 * The Scheduler's work: the `settle`, `check_timeout` and `sign_hook` calls
 * the oracle would accept at `nowNs`. `settle` is due for an undisputed
 * Assertion from the end of Liveness and for a ruled one from the end of its
 * Appeal Window; `check_timeout` for a disputed Assertion with no AI Verdict
 * once the AI Verdict deadline has passed; `sign_hook` for every unsigned EVM
 * Hook of a settled Assertion.
 */
export function dueCalls(
  assertions: readonly OracleAssertion[],
  { nowNs, aiVerdictDeadlineSecs }: DueCallOptions,
): DueCall[] {
  const calls: DueCall[] = [];
  for (const assertion of assertions) {
    const call = (method: DueCall["method"]) => ({
      method,
      args: { assertion_id: assertion.id },
      gas: SCHEDULER_GAS,
      deposit: "0",
    });
    if (assertion.state === "asserted" && nowNs >= BigInt(assertion.liveness_ends_at_ns)) {
      calls.push(call("settle"));
    } else if (
      assertion.state === "ruled" &&
      assertion.appeal_window_ends_at_ns !== null &&
      nowNs >= BigInt(assertion.appeal_window_ends_at_ns)
    ) {
      calls.push(call("settle"));
    } else if (
      assertion.state === "disputed" &&
      aiVerdictDeadlineSecs !== undefined &&
      assertion.dispute !== null &&
      assertion.ai_verdicts.length === 0 &&
      nowNs >=
        BigInt(assertion.dispute.disputed_at_ns) + BigInt(aiVerdictDeadlineSecs) * 1_000_000_000n
    ) {
      calls.push(call("check_timeout"));
    }
  }
  for (const hook of evmHooksToSign(assertions)) {
    calls.push({
      method: "sign_hook",
      args: { assertion_id: hook.assertionId, hook_index: hook.hookIndex },
      gas: SIGN_HOOK_GAS,
      deposit: SIGN_HOOK_DEPOSIT_YOCTO,
    });
  }
  return calls;
}
