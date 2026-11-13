import { getTransactionLastResult } from "near-api-js";
import { NearProvider, useNearWallet } from "near-connect-hooks";
import { useEffect } from "react";
import { config } from "@/config";
import type { OracleCall, Wallet } from "./wallet";

/** Loads near-connect in the browser and reports the wallet's state to `WalletProvider`. */
export default function NearBridge({ onChange }: { onChange: (wallet: Wallet) => void }) {
  return (
    <NearProvider
      config={{ network: config.network, providers: { [config.network]: [config.rpcUrl] } }}
    >
      <Sync onChange={onChange} />
    </NearProvider>
  );
}

function Sync({ onChange }: { onChange: (wallet: Wallet) => void }) {
  const near = useNearWallet();

  useEffect(() => {
    onChange({
      loading: near.loading,
      accountId: near.signedAccountId || null,
      signIn: () => near.signIn(),
      signOut: () => near.signOut(),
      call: async ({ method, args, deposit, gas }: OracleCall) => {
        const outcome = await near.callFunctionRaw({
          contractId: config.oracleAccountId,
          method,
          args,
          deposit,
          gas,
        });
        const transactionHash = outcome.transaction_outcome.id;
        const status = outcome.status as { Failure?: unknown };
        if (typeof status === "object" && status.Failure) {
          throw new Error(
            `${method} failed (${transactionHash}): ${failureMessage(status.Failure)}`,
          );
        }
        return { transactionHash, value: getTransactionLastResult(outcome) };
      },
    });
    // The hook's functions read its current state, which these two values track.
  }, [near.loading, near.signedAccountId]);

  return null;
}

/** The panic message inside a NEAR execution failure, if there is one. */
function failureMessage(failure: unknown): string {
  const text = JSON.stringify(failure);
  return (
    /"panic_msg":"((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ??
    /"ExecutionError":"((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ??
    text
  );
}
