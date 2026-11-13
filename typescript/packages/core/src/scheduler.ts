import type { OracleAssertion } from "./oracle-reads.ts";
import { SIGN_HOOK_DEPOSIT_YOCTO, SIGN_HOOK_GAS, evmHooksToSign } from "./relayer.ts";

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
}

/**
 * The Scheduler's work: the `settle`, `check_timeout` and `sign_hook` calls
 * the oracle would accept at `nowNs`. `settle` is due for an undisputed
 * Assertion from the end of Liveness, for a ruled one from the end of its
 * Appeal Window and for one In Appeal from its DAO deadline; `check_timeout`
 * for a disputed Assertion with no AI Verdict from its dispute's AI Verdict
 * deadline; `sign_hook` for every unsigned EVM Hook of a settled Assertion.
 * Every deadline is read from the Assertion, where the oracle fixed it when
 * the timer started.
 */
export function dueCalls(
  assertions: readonly OracleAssertion[],
  { nowNs }: DueCallOptions,
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
      assertion.state === "in_appeal" &&
      assertion.appeal !== null &&
      nowNs >= BigInt(assertion.appeal.dao_deadline_ns)
    ) {
      calls.push(call("settle"));
    } else if (
      assertion.state === "disputed" &&
      assertion.dispute !== null &&
      assertion.ai_verdicts.length === 0 &&
      nowNs >= BigInt(assertion.dispute.ai_verdict_deadline_ns)
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
