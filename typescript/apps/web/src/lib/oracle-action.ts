import { useState } from "react";
import { useWallet, type OracleCall } from "@/lib/wallet";

/**
 * Sends one oracle call from the wallet and reports its transaction, result
 * and error. `onDone` runs after the call succeeds, for example to re-read
 * what it changed; an error it throws is reported like the call's.
 */
export function useOracleAction(onDone: () => void | Promise<void>) {
  const wallet = useWallet();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState<{ hash: string; value: unknown } | null>(null);

  async function run(call: OracleCall) {
    setPending(true);
    setError(null);
    try {
      const { transactionHash, value } = await wallet.call(call);
      setSent({ hash: transactionHash, value });
      await onDone();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }

  return { wallet, pending, error, sent, run };
}
