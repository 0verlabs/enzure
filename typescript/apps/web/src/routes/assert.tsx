import { putContent } from "@enzure/core";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CloudUploadIcon, HourglassIcon, PenLineIcon, WalletIcon } from "lucide-react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { z } from "zod";
import { useMounted, useNowNs } from "@/components/assertion-bits";
import { ContentField } from "@/components/content-field";
import { ErrorAlert } from "@/components/error-alert";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { config, missingConfig } from "@/config";
import { nearToYocto, yoctoToNear } from "@/lib/near-amount";
import { CALL_GAS, formatNear, formatTime, oracle } from "@/lib/oracle";
import { cn } from "@/lib/utils";
import { useWallet } from "@/lib/wallet";

/** Liveness choices in seconds; the contract allows 1 minute to 7 days. */
const LIVENESS = [
  { label: "1 min", seconds: 60 },
  { label: "10 min", seconds: 600 },
  { label: "1 hour", seconds: 3600 },
  { label: "2 hours", seconds: 7200 },
  { label: "1 day", seconds: 86_400 },
] as const;

/** Units for a custom Liveness, in seconds each. */
const UNITS = [
  { label: "Minutes", value: "60" },
  { label: "Hours", value: "3600" },
  { label: "Days", value: "86400" },
];

/** The value of the Liveness toggle that opens the custom amount. */
const CUSTOM = "custom";

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
    liveness: z
      .number({ error: "Enter a whole number" })
      .int("Enter a whole number")
      .min(MIN_LIVENESS_SECS, "Liveness is at least 1 minute")
      .max(MAX_LIVENESS_SECS, "Liveness is at most 7 days"),
  });
}

export const Route = createFileRoute("/assert")({
  loader: async () => {
    if (missingConfig.includes("ORACLE_ACCOUNT_ID")) return { minBond: null, storageDeposit: null };
    const [oracleConfig, storageDeposit] = await Promise.all([
      oracle.getConfig(),
      oracle.assertionStorageDeposit().catch(() => null),
    ]);
    return { minBond: oracleConfig.min_bond, storageDeposit };
  },
  head: () => ({ meta: [{ title: "Post an Assertion · Enzure" }] }),
  component: PostAssertion,
});

type Step = "idle" | "uploading" | "signing";

function PostAssertion() {
  const { minBond, storageDeposit } = Route.useLoaderData();
  const wallet = useWallet();
  const navigate = useNavigate();
  const [claim, setClaim] = useState("");
  const [evidence, setEvidence] = useState("");
  const [bond, setBond] = useState<string>(minBond ? yoctoToNear(minBond) : "1");
  const [livenessChoice, setLivenessChoice] = useState("7200");
  const [customAmount, setCustomAmount] = useState("3");
  const [customUnit, setCustomUnit] = useState("86400");
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<unknown>(null);

  const form = useMemo(() => postForm(minBond), [minBond]);
  const custom = livenessChoice === CUSTOM;
  const liveness = custom
    ? /^\d+$/.test(customAmount.trim())
      ? Number(customAmount.trim()) * Number(customUnit)
      : Number.NaN
    : Number(livenessChoice);
  const parsed = form.safeParse({ claim, evidence, bond, liveness });
  const livenessIssue = parsed.success
    ? undefined
    : parsed.error.issues.find((issue) => issue.path[0] === "liveness");
  const bondIssue = parsed.success
    ? undefined
    : parsed.error.issues.find((issue) => issue.path[0] === "bond");
  const busy = step !== "idle";
  const canSubmit = !busy && !!wallet.accountId && parsed.success && missingConfig.length === 0;
  const bondYocto = nearToYocto(bond);

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
      const deposit = await oracle.assertionStorageDeposit();

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
        deposit: (BigInt(post.bond) + BigInt(deposit)).toString(),
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
    <>
      <PageHeader
        title="Post an Assertion"
        description="The Claim and Evidence are uploaded to storage and only their sha256 hashes go on-chain. If nobody disputes the Claim before Liveness ends, it settles TRUE and your bond comes back."
      />
      <form onSubmit={submit}>
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <Card>
            <CardHeader>
              <CardTitle>The Claim</CardTitle>
              <CardDescription>
                Write it so a reader can tell TRUE from FALSE using the Evidence alone.
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
                  rows={5}
                />
                <ContentField
                  label="Evidence (optional)"
                  description="Text that supports the Claim. A Disputer and the AI Verdict read it."
                  value={evidence}
                  onChange={setEvidence}
                  disabled={busy}
                />
                <FieldSeparator />
                <div className="grid gap-6 sm:grid-cols-[12rem_minmax(0,1fr)]">
                  <Field data-invalid={bondIssue ? true : undefined}>
                    <FieldLabel htmlFor="bond">Bond</FieldLabel>
                    <InputGroup>
                      <InputGroupInput
                        id="bond"
                        inputMode="decimal"
                        value={bond}
                        onChange={(event) => setBond(event.target.value)}
                        aria-invalid={bondIssue ? true : undefined}
                        disabled={busy}
                        className="tabular-nums"
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupText>NEAR</InputGroupText>
                      </InputGroupAddon>
                    </InputGroup>
                    <FieldDescription>
                      {minBond ? `At least ${formatNear(minBond)}. ` : ""}A Disputer must match it.
                    </FieldDescription>
                    {bondIssue ? <FieldError>{bondIssue.message}</FieldError> : null}
                  </Field>
                  <Field data-invalid={custom && livenessIssue ? true : undefined}>
                    <FieldLabel>Liveness</FieldLabel>
                    <ToggleGroup
                      variant="outline"
                      spacing={0}
                      value={[livenessChoice]}
                      onValueChange={(value) => value[0] && setLivenessChoice(value[0])}
                      disabled={busy}
                      className="w-full flex-wrap"
                    >
                      {LIVENESS.map((option) => (
                        <ToggleGroupItem
                          key={option.seconds}
                          value={String(option.seconds)}
                          className="flex-1"
                        >
                          {option.label}
                        </ToggleGroupItem>
                      ))}
                      <ToggleGroupItem value={CUSTOM} className="flex-1">
                        Custom
                      </ToggleGroupItem>
                    </ToggleGroup>
                    {custom ? (
                      <div className="flex gap-2">
                        <InputGroup className="max-w-32">
                          <InputGroupInput
                            aria-label="Liveness amount"
                            inputMode="numeric"
                            value={customAmount}
                            onChange={(event) => setCustomAmount(event.target.value)}
                            aria-invalid={livenessIssue ? true : undefined}
                            disabled={busy}
                            className="tabular-nums"
                          />
                        </InputGroup>
                        <Select
                          items={UNITS}
                          value={customUnit}
                          onValueChange={(value) => value && setCustomUnit(value)}
                          disabled={busy}
                        >
                          <SelectTrigger aria-label="Liveness unit" className="w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {UNITS.map((unit) => (
                                <SelectItem key={unit.value} value={unit.value}>
                                  {unit.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </div>
                    ) : null}
                    <FieldDescription>
                      How long anyone can dispute the Claim: 1 minute to 7 days.
                    </FieldDescription>
                    {custom && livenessIssue ? (
                      <FieldError>{livenessIssue.message}</FieldError>
                    ) : null}
                  </Field>
                </div>
              </FieldGroup>
            </CardContent>
          </Card>

          <aside className="flex flex-col gap-4 lg:sticky lg:top-20">
            <Card>
              <CardHeader>
                <CardTitle>What you send</CardTitle>
                <CardDescription>Attached to the transaction you sign.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <dl className="flex flex-col gap-2.5 text-sm">
                  <Line label="Bond" value={bondYocto ? formatNear(bondYocto) : "–"} />
                  <Line
                    label="Storage deposit"
                    value={storageDeposit ? formatNear(storageDeposit) : "–"}
                  />
                  <Separator />
                  <Line
                    strong
                    label="Total"
                    value={
                      bondYocto && storageDeposit
                        ? formatNear(BigInt(bondYocto) + BigInt(storageDeposit))
                        : "–"
                    }
                  />
                </dl>
                <LivenessEnds seconds={livenessIssue ? null : liveness} />
                {error ? <ErrorAlert error={error} title="Posting failed" /> : null}
                {wallet.accountId || wallet.loading ? (
                  <Button type="submit" size="lg" className="h-11" disabled={!canSubmit}>
                    {busy ? <Spinner data-icon="inline-start" /> : null}
                    {step === "uploading"
                      ? "Uploading…"
                      : step === "signing"
                        ? "Confirm in your wallet…"
                        : "Post Assertion"}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="lg"
                    className="h-11"
                    onClick={() => void wallet.signIn()}
                  >
                    <WalletIcon data-icon="inline-start" />
                    Connect a wallet to post
                  </Button>
                )}
              </CardContent>
            </Card>
            <ol className="flex flex-col gap-3 px-1 text-sm">
              <HowStep icon={<CloudUploadIcon />} active={step === "uploading"}>
                The Claim and Evidence upload to storage.
              </HowStep>
              <HowStep icon={<PenLineIcon />} active={step === "signing"}>
                You sign <code className="font-mono text-xs">assert_claim</code> with their hashes.
              </HowStep>
              <HowStep icon={<HourglassIcon />} active={false}>
                Liveness starts; anyone can dispute until it ends.
              </HowStep>
            </ol>
          </aside>
        </div>
      </form>
    </>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={strong ? "font-medium" : "text-muted-foreground"}>{label}</dt>
      <dd className={cn("tabular-nums", strong && "font-heading text-lg font-semibold")}>
        {value}
      </dd>
    </div>
  );
}

/** When Liveness would end if the Assertion were posted now. */
function LivenessEnds({ seconds }: { seconds: number | null }) {
  const now = useNowNs();
  const mounted = useMounted();
  return (
    <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-xs text-muted-foreground">
      Posted now, Liveness ends{" "}
      <span className="text-foreground">
        {seconds === null
          ? "–"
          : mounted
            ? formatTime(now + BigInt(seconds) * 1_000_000_000n)
            : "…"}
      </span>
      .
    </p>
  );
}

function HowStep({
  icon,
  active,
  children,
}: {
  icon: ReactNode;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors [&>svg]:size-3.5",
          active && "border-primary/50 bg-primary/10 text-primary",
        )}
      >
        {icon}
      </span>
      <span className={cn("pt-1 text-muted-foreground", active && "text-foreground")}>
        {children}
      </span>
    </li>
  );
}
