import {
  SIGN_HOOK_DEPOSIT_YOCTO,
  SIGN_HOOK_GAS,
  fetchEvmDelivery,
  type EvmDelivery,
  type SignedResultView,
  type TimelineStep,
} from "@enzure/core";
import { useEffect, useState } from "react";
import { Account, EvmTxLink, TxLink } from "@/components/assertion-bits";
import { ErrorAlert } from "@/components/error-alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { config, evmAddressUrl } from "@/config";
import { RETRY_HOOK_GAS, formatTime, oracle, shortHash } from "@/lib/oracle";
import { useWallet } from "@/lib/wallet";

type NearHookStep = Extract<TimelineStep, { kind: "near_hook" }>;
type EvmHookStep = Extract<TimelineStep, { kind: "evm_hook" }>;

/** How often an undelivered EVM Hook re-reads its Receiver. */
const DELIVERY_REFRESH_MS = 15_000;

/** Sends one oracle call from the wallet and reports its transaction, result and error. */
function useOracleAction(onDone: () => void) {
  const wallet = useWallet();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState<{ hash: string; value: unknown } | null>(null);

  async function run(call: Parameters<typeof wallet.call>[0]) {
    setPending(true);
    setError(null);
    try {
      const { transactionHash, value } = await wallet.call(call);
      setSent({ hash: transactionHash, value });
      onDone();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }

  return { wallet, pending, error, sent, run };
}

const NEAR_STATUS = {
  pending: { label: "Pending", variant: "outline" },
  delivering: { label: "Delivering", variant: "secondary" },
  delivered: { label: "Delivered", variant: "default" },
  failed: { label: "Failed", variant: "destructive" },
} as const;

/** A NEAR Hook's delivery to its Consumer, with a retry button once it failed. */
export function NearHookDetail({
  assertionId,
  step,
  onChanged,
}: {
  assertionId: number;
  step: NearHookStep;
  onChanged: () => void;
}) {
  const action = useOracleAction(onChanged);
  const status = NEAR_STATUS[step.status] ?? { label: step.status, variant: "outline" };

  return (
    <div className="flex flex-col gap-2">
      <span className="flex flex-wrap items-center gap-2">
        <Badge variant={status.variant}>{status.label}</Badge>
        <span>
          to <Account id={step.consumer} />
        </span>
      </span>
      {step.status === "failed" ? (
        <span className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            disabled={action.pending || !action.wallet.accountId}
            onClick={() =>
              action.run({
                method: "retry_near_hook",
                args: { assertion_id: assertionId, hook_index: step.hookIndex },
                deposit: "0",
                gas: RETRY_HOOK_GAS,
              })
            }
          >
            {action.pending ? <Spinner data-icon="inline-start" /> : null}
            Retry delivery
          </Button>
          {!action.wallet.accountId && !action.wallet.loading ? (
            <span>Connect a wallet to retry.</span>
          ) : null}
        </span>
      ) : null}
      {action.sent ? (
        <span>
          {action.sent.value === true ? "Delivered" : "Failed again"} in{" "}
          <TxLink hash={action.sent.hash} />
        </span>
      ) : null}
      {action.error ? <ErrorAlert error={action.error} title="Retry failed" /> : null}
    </div>
  );
}

/** The Receiver's record of an EVM Hook, re-read until it is delivered. Null on chains the app doesn't read. */
function useEvmDelivery(step: EvmHookStep, assertionId: number) {
  const [delivery, setDelivery] = useState<EvmDelivery | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const readable = step.chainId === config.evm.chainId && step.status === "signed";

  useEffect(() => {
    if (!readable) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () =>
      fetchEvmDelivery(
        { rpcUrl: config.evm.rpcUrl, logsApiUrl: config.evm.logsApiUrl },
        { receiver: step.receiver, consumer: step.consumer, assertionId },
      )
        .then((found) => {
          if (cancelled) return;
          setFailed(null);
          setDelivery(found);
          if (!found.delivered || !found.transactionHash)
            timer = setTimeout(read, DELIVERY_REFRESH_MS);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : String(error);
          setFailed(message);
          // A Receiver address without a contract won't change; anything else may be a passing RPC error.
          if (!message.startsWith("No Receiver contract"))
            timer = setTimeout(read, DELIVERY_REFRESH_MS);
        });
    void read();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [readable, step.receiver, step.consumer, assertionId]);

  return { delivery, failed, readable };
}

/** A signed result as `get_signed_result` returns it, read once the Hook is signed. */
function useSignedResult(step: EvmHookStep, assertionId: number) {
  const [signed, setSigned] = useState<SignedResultView | null>(null);
  useEffect(() => {
    if (step.status !== "signed") return;
    let cancelled = false;
    oracle
      .getSignedResult(assertionId, step.hookIndex)
      .then((found) => !cancelled && setSigned(found))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [step.status, step.hookIndex, assertionId]);
  return signed;
}

/**
 * An EVM Hook: unsigned, signing, signed or delivered, with a button to start
 * signing an unsigned one, the signed result, and the Receiver's record of
 * the delivery with its transaction.
 */
export function EvmHookDetail({
  assertionId,
  step,
  onChanged,
}: {
  assertionId: number;
  step: EvmHookStep;
  onChanged: () => void;
}) {
  const action = useOracleAction(onChanged);
  const { delivery, failed, readable } = useEvmDelivery(step, assertionId);
  const signed = useSignedResult(step, assertionId);
  const chain = step.chainId === config.evm.chainId ? config.evm.name : `chain ${step.chainId}`;
  const delivered = delivery?.delivered === true;

  return (
    <div className="flex flex-col gap-2">
      <span className="flex flex-wrap items-center gap-2">
        {delivered ? (
          <Badge>Delivered</Badge>
        ) : step.status === "signed" ? (
          <Badge variant="secondary">Signed, waiting for a Relayer</Badge>
        ) : step.status === "signing" ? (
          <Badge variant="secondary">
            <Spinner data-icon="inline-start" />
            Signing
          </Badge>
        ) : (
          <Badge variant="outline">Unsigned</Badge>
        )}
        <span>
          to <EvmAddress address={step.consumer} chainId={step.chainId} /> on {chain}, through
          Receiver <EvmAddress address={step.receiver} chainId={step.chainId} />
        </span>
      </span>
      {signed ? (
        <span className="font-mono text-xs">
          Signed result: {signed.outcome ? "TRUE" : "FALSE"}, settled{" "}
          {formatTime(BigInt(signed.settled_at) * 1_000_000_000n)}, digest{" "}
          {shortHash(signed.digest)}, signature v={signed.v} r={shortHash(signed.r)} s=
          {shortHash(signed.s)}
        </span>
      ) : null}
      {delivery?.outcome.recorded ? (
        <span className="flex flex-wrap items-center gap-2">
          Receiver recorded {delivery.outcome.truthful ? "TRUE" : "FALSE"}
          {delivery.transactionHash ? (
            <>
              in <EvmTxLink hash={delivery.transactionHash} />
            </>
          ) : delivered ? (
            <Spinner className="size-3" />
          ) : null}
        </span>
      ) : null}
      {readable && failed ? (
        <span>
          Couldn&apos;t read the Receiver on {chain}: {failed}
        </span>
      ) : null}
      {step.status === "unsigned" ? (
        <span className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            disabled={action.pending || !action.wallet.accountId}
            onClick={() =>
              action.run({
                method: "sign_hook",
                args: { assertion_id: assertionId, hook_index: step.hookIndex },
                deposit: SIGN_HOOK_DEPOSIT_YOCTO,
                gas: SIGN_HOOK_GAS,
              })
            }
          >
            {action.pending ? <Spinner data-icon="inline-start" /> : null}
            Start signing
          </Button>
          {!action.wallet.accountId && !action.wallet.loading ? (
            <span>Connect a wallet to sign; a Keeper also signs it.</span>
          ) : null}
        </span>
      ) : null}
      {action.sent ? (
        <span>
          {action.sent.value === false ? "The signer failed or timed out; try again." : "Signed"} in{" "}
          <TxLink hash={action.sent.hash} />
        </span>
      ) : null}
      {action.error ? <ErrorAlert error={action.error} title="Signing failed" /> : null}
    </div>
  );
}

function EvmAddress({ address, chainId }: { address: string; chainId: number }) {
  if (chainId !== config.evm.chainId)
    return <span className="font-mono text-xs">{shortHash(address)}</span>;
  return (
    <a
      href={evmAddressUrl(address)}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs underline-offset-4 hover:underline"
    >
      {shortHash(address)}
    </a>
  );
}
