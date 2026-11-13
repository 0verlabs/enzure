import { useCallback, useEffect, useState } from "react";
import { TxLink } from "@/components/assertion-bits";
import { ErrorAlert } from "@/components/error-alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { CALL_GAS, formatNear, oracle } from "@/lib/oracle";
import { useWallet } from "@/lib/wallet";

/** The connected account's withdrawable balance in the oracle, with a Withdraw button. */
export function BalanceCard() {
  const wallet = useWallet();
  const [balance, setBalance] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [withdrawal, setWithdrawal] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!wallet.accountId) return setBalance(null);
    setBalance(await oracle.getBalance(wallet.accountId));
  }, [wallet.accountId]);

  useEffect(() => {
    refresh().catch(setError);
  }, [refresh]);

  if (!wallet.accountId) return null;

  async function withdraw() {
    setPending(true);
    setError(null);
    try {
      // `withdraw` needs exactly one yoctoNEAR; without an amount it sends the whole balance.
      const { transactionHash } = await wallet.call({
        method: "withdraw",
        args: {},
        deposit: "1",
        gas: CALL_GAS,
      });
      setWithdrawal(transactionHash);
      await refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your balance</CardTitle>
        <CardDescription className="flex flex-col gap-1">
          <span>
            {balance === null ? "Loading…" : formatNear(balance)} to withdraw from returned bonds
            and payouts.
          </span>
          {withdrawal ? (
            <span>
              Withdrawal sent: <TxLink hash={withdrawal} />
            </span>
          ) : null}
        </CardDescription>
        <CardAction>
          <Button disabled={pending || !balance || BigInt(balance) === 0n} onClick={withdraw}>
            {pending ? <Spinner data-icon="inline-start" /> : null}
            Withdraw
          </Button>
        </CardAction>
      </CardHeader>
      {error ? (
        <div className="px-6">
          <ErrorAlert error={error} />
        </div>
      ) : null}
    </Card>
  );
}
