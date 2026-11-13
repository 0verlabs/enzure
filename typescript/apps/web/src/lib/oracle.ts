import { nearRpcView, type OracleAssertion, type SignedResultView } from "@enzure/core";
import { config } from "@/config";
import { yoctoToNear } from "@/lib/near-amount";

/** Calls the oracle's view methods; works in the browser and in the Worker. */
export const view = nearRpcView({ rpcUrl: config.rpcUrl, contractId: config.oracleAccountId });

export const PAGE_SIZE = 20;

export const oracle = {
  listAssertions: (beforeId?: number) =>
    view<OracleAssertion[]>("list_assertions", {
      limit: PAGE_SIZE,
      ...(beforeId === undefined ? {} : { before_id: beforeId }),
    }),
  getAssertion: (id: number) => view<OracleAssertion>("get_assertion", { assertion_id: id }),
  getConfig: () =>
    view<{ dao: string; min_bond: string; default_liveness: number }>("get_config", {}),
  getBalance: (accountId: string) => view<string>("get_balance", { account_id: accountId }),
  assertionStorageDeposit: () => view<string>("assertion_storage_deposit", { hooks: 0 }),
  disputeStorageDeposit: () => view<string>("dispute_storage_deposit", {}),
  getSignedResult: (assertionId: number, hookIndex: number) =>
    view<SignedResultView | null>("get_signed_result", {
      assertion_id: assertionId,
      hook_index: hookIndex,
    }),
};

/** Gas for oracle calls: enough for `assert_claim`, `dispute`, `appeal` and `withdraw` with their refunds. */
export const CALL_GAS = "100000000000000";

/** Gas for `retry_near_hook`: the Hook's own gas (the oracle caps it so this fits) plus the oracle's callback. */
export const RETRY_HOOK_GAS = "300000000000000";

/** `1.25 NEAR` for a yoctoNEAR amount. */
export function formatNear(yocto: string | bigint, decimals = 4): string {
  return `${yoctoToNear(yocto, decimals)} NEAR`;
}

export function formatTime(ns: string | bigint): string {
  return new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleString();
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}
