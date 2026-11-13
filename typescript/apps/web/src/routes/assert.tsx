import { putContent } from "@enzure/core";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { ContentField } from "@/components/content-field";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { config, missingConfig } from "@/config";
import { nearToYocto, yoctoToNear } from "@/lib/near-amount";
import { CALL_GAS, formatNear, oracle } from "@/lib/oracle";
import { useWallet } from "@/lib/wallet";

/** Liveness choices in seconds; the contract allows 1 minute to 7 days. */
const LIVENESS = [
  { label: "1 min", seconds: 60 },
  { label: "10 min", seconds: 600 },
  { label: "1 hour", seconds: 3600 },
  { label: "2 hours", seconds: 7200 },
  { label: "1 day", seconds: 86_400 },
] as const;

export const Route = createFileRoute("/assert")({
  loader: async () =>
    missingConfig.includes("ORACLE_ACCOUNT_ID")
      ? { minBond: null }
      : { minBond: (await oracle.getConfig()).min_bond },
  component: PostAssertion,
});

type Step = "idle" | "uploading" | "signing";

function PostAssertion() {
  const { minBond } = Route.useLoaderData();
  const wallet = useWallet();
  const navigate = useNavigate();
  const [claim, setClaim] = useState("");
  const [evidence, setEvidence] = useState("");
  const [bond, setBond] = useState<string>(minBond ? yoctoToNear(minBond) : "1");
  const [liveness, setLiveness] = useState("7200");
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<unknown>(null);

  const bondYocto = nearToYocto(bond);
  const tooSmall = bondYocto !== null && minBond !== null && BigInt(bondYocto) < BigInt(minBond);
  const busy = step !== "idle";
  const canSubmit =
    !busy &&
    !!wallet.accountId &&
    claim.trim() !== "" &&
    bondYocto !== null &&
    !tooSmall &&
    missingConfig.length === 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || bondYocto === null) return;
    setError(null);
    try {
      setStep("uploading");
      const storage = { storageUrl: config.storageUrl };
      const claimHash = await putContent(storage, claim);
      const evidenceHash = evidence === "" ? null : await putContent(storage, evidence);
      const storageDeposit = await oracle.assertionStorageDeposit();

      setStep("signing");
      const { value } = await wallet.call({
        method: "assert_claim",
        args: {
          claim_hash: claimHash,
          evidence_hash: evidenceHash,
          bond: bondYocto,
          liveness: Number(liveness),
          hooks: [],
        },
        deposit: (BigInt(bondYocto) + BigInt(storageDeposit)).toString(),
        gas: CALL_GAS,
      });
      await navigate({ to: "/assertions/$id", params: { id: Number(value) } });
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
          <CardTitle>Post an Assertion</CardTitle>
          <CardDescription>
            The Claim and Evidence are uploaded to storage and only their sha256 hashes go on-chain.
            If nobody disputes the Claim before Liveness ends, it settles TRUE and your bond comes
            back.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <ContentField
              label="Claim"
              description="A statement that is either true or false."
              value={claim}
              onChange={setClaim}
              placeholder="The deliverable in the Asserter's Evidence satisfies the brief…"
              disabled={busy}
            />
            <ContentField
              label="Evidence (optional)"
              description="Text that supports the Claim. A Disputer and the AI Verdict read it."
              value={evidence}
              onChange={setEvidence}
              disabled={busy}
            />
            <Field data-invalid={tooSmall || bondYocto === null || undefined}>
              <FieldLabel htmlFor="bond">Bond (NEAR)</FieldLabel>
              <Input
                id="bond"
                inputMode="decimal"
                value={bond}
                onChange={(event) => setBond(event.target.value)}
                aria-invalid={tooSmall || bondYocto === null || undefined}
                disabled={busy}
                className="max-w-40"
              />
              <FieldDescription>
                {minBond ? `At least ${formatNear(minBond)}. ` : ""}A Disputer must match it. The
                storage deposit is added on top.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Liveness</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                value={liveness}
                onValueChange={(value) => value && setLiveness(value)}
                disabled={busy}
              >
                {LIVENESS.map((option) => (
                  <ToggleGroupItem key={option.seconds} value={String(option.seconds)}>
                    {option.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FieldDescription>How long anyone can dispute the Claim.</FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="flex flex-col items-stretch gap-4">
          {error ? <ErrorAlert error={error} title="Posting failed" /> : null}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!canSubmit}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {step === "uploading"
                ? "Uploading…"
                : step === "signing"
                  ? "Confirm in your wallet…"
                  : "Post Assertion"}
            </Button>
            {!wallet.accountId && !wallet.loading ? (
              <span className="text-sm text-muted-foreground">Connect a wallet to post.</span>
            ) : null}
          </div>
        </CardFooter>
      </Card>
    </form>
  );
}
