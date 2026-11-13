import { putContent } from "@enzure/core";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent } from "react";
import { z } from "zod";
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
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

/** The contract's Liveness bounds, in seconds: 1 minute to 7 days. */
const MIN_LIVENESS_SECS = 60;
const MAX_LIVENESS_SECS = 7 * 24 * 60 * 60;

/**
 * The post form, checked before anything is uploaded or signed. The Claim and
 * Evidence are kept exactly as typed, since their bytes are what gets hashed;
 * the bond becomes yoctoNEAR and must be at least `minBond` when it is known.
 */
function postForm(minBond: string | null) {
  return z.object({
    claim: z.string().refine((text) => text.trim() !== "", "Write a Claim"),
    evidence: z.string(),
    bond: z
      .string()
      .transform((near, ctx) => {
        const yocto = nearToYocto(near);
        if (yocto === null) {
          ctx.addIssue({ code: "custom", message: "Enter an amount of NEAR, such as 1.5" });
          return z.NEVER;
        }
        return yocto;
      })
      .refine(
        (yocto) => minBond === null || BigInt(yocto) >= BigInt(minBond),
        "The bond is below the oracle's minimum",
      ),
    liveness: z.coerce.number().int().min(MIN_LIVENESS_SECS).max(MAX_LIVENESS_SECS),
  });
}

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

  const form = useMemo(() => postForm(minBond), [minBond]);
  const parsed = form.safeParse({ claim, evidence, bond, liveness });
  const bondIssue = parsed.success
    ? undefined
    : parsed.error.issues.find((issue) => issue.path[0] === "bond");
  const busy = step !== "idle";
  const canSubmit = !busy && !!wallet.accountId && parsed.success && missingConfig.length === 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || !parsed.success) return;
    const post = parsed.data;
    setError(null);
    try {
      setStep("uploading");
      const storage = { storageUrl: config.storageUrl };
      const claimHash = await putContent(storage, post.claim);
      const evidenceHash = post.evidence === "" ? null : await putContent(storage, post.evidence);
      const storageDeposit = await oracle.assertionStorageDeposit();

      setStep("signing");
      const { value } = await wallet.call({
        method: "assert_claim",
        args: {
          claim_hash: claimHash,
          evidence_hash: evidenceHash,
          bond: post.bond,
          liveness: post.liveness,
          hooks: [],
        },
        deposit: (BigInt(post.bond) + BigInt(storageDeposit)).toString(),
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
            <Field data-invalid={bondIssue ? true : undefined}>
              <FieldLabel htmlFor="bond">Bond (NEAR)</FieldLabel>
              <Input
                id="bond"
                inputMode="decimal"
                value={bond}
                onChange={(event) => setBond(event.target.value)}
                aria-invalid={bondIssue ? true : undefined}
                disabled={busy}
                className="max-w-40"
              />
              <FieldDescription>
                {minBond ? `At least ${formatNear(minBond)}. ` : ""}A Disputer must match it. The
                storage deposit is added on top.
              </FieldDescription>
              {bondIssue ? <FieldError>{bondIssue.message}</FieldError> : null}
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
