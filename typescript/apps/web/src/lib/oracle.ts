import { nearRpcView, type OracleAssertion } from "@enzure/core";
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
};

/** Gas for oracle calls: enough for `assert_claim`, `dispute` and `withdraw` with their refunds. */
export const CALL_GAS = "100000000000000";

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
