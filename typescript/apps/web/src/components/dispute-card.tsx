import { putContent, type OracleAssertion } from "@enzure/core";
import { useState, type FormEvent } from "react";
import { Countdown, TxLink } from "@/components/assertion-bits";
import { ContentField } from "@/components/content-field";
import { ErrorAlert } from "@/components/error-alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { config } from "@/config";
import { CALL_GAS, formatNear, oracle } from "@/lib/oracle";
import { useWallet } from "@/lib/wallet";

/** Disputes an Assertion still in Liveness, with the Disputer's Evidence and a matching bond. */
export function DisputeCard({
  assertion,
  onDisputed,
}: {
  assertion: OracleAssertion;
  onDisputed: () => void;
}) {
  const wallet = useWallet();
  const [evidence, setEvidence] = useState("");
  const [step, setStep] = useState<"idle" | "uploading" | "signing">("idle");
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState<string | null>(null);
  const busy = step !== "idle";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      setStep("uploading");
      const evidenceHash =
        evidence === "" ? null : await putContent({ storageUrl: config.storageUrl }, evidence);
      const storageDeposit = await oracle.disputeStorageDeposit();
      setStep("signing");
      const { transactionHash } = await wallet.call({
        method: "dispute",
        args: { assertion_id: assertion.id, evidence_hash: evidenceHash },
        deposit: (BigInt(assertion.bond) + BigInt(storageDeposit)).toString(),
        gas: CALL_GAS,
      });
      setSent(transactionHash);
      onDisputed();
    } catch (cause) {
      setError(cause);
    } finally {
      setStep("idle");
    }
  }

  return (
    <form onSubmit={submit}>
      <Card>
        <CardHeader>
          <CardTitle>Dispute this Assertion</CardTitle>
          <CardDescription>
            Think the Claim is false? Dispute it within{" "}
            <Countdown endsAtNs={assertion.liveness_ends_at_ns} /> with a bond of{" "}
            {formatNear(assertion.bond)} plus a storage deposit. An AI Verdict then decides, and the
            winner gets half the loser&apos;s bond.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ContentField
            label="Your Evidence (optional)"
            description="Uploaded to storage; its hash goes on-chain with the dispute."
            value={evidence}
            onChange={setEvidence}
            disabled={busy}
          />
        </CardContent>
        <CardFooter className="flex flex-col items-stretch gap-4">
          {error ? <ErrorAlert error={error} title="Dispute failed" /> : null}
          {sent ? (
            <p className="text-sm">
              Disputed in <TxLink hash={sent} />
            </p>
          ) : null}
          <div className="flex flex-col gap-3">
            <Button
              type="submit"
              variant="destructive"
              size="lg"
              className="h-10"
              disabled={busy || !wallet.accountId}
            >
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {step === "uploading"
                ? "Uploading…"
                : step === "signing"
                  ? "Confirm in your wallet…"
                  : `Dispute with ${formatNear(assertion.bond)}`}
            </Button>
            {!wallet.accountId && !wallet.loading ? (
              <span className="text-sm text-muted-foreground">Connect a wallet to dispute.</span>
            ) : null}
          </div>
        </CardFooter>
      </Card>
    </form>
  );
}
