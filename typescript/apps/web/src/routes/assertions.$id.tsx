import { canAppeal, type OracleAssertion } from "@enzure/core";
import { createFileRoute, Link, notFound, useRouter } from "@tanstack/react-router";
import { ArrowLeftIcon, CheckCircle2Icon, SearchXIcon, XCircleIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { z } from "zod";
import {
  Account,
  Countdown,
  LocalTime,
  StateBadge,
  useMounted,
  useNowNs,
  windowProgress,
} from "@/components/assertion-bits";
import { AppealCard } from "@/components/appeal-card";
import { ContentCard } from "@/components/content-card";
import { DisputeCard } from "@/components/dispute-card";
import { ErrorAlert } from "@/components/error-alert";
import { PageHeader } from "@/components/page-header";
import { StageTrack, stagesOf } from "@/components/stage-track";
import { Timeline, appealReason } from "@/components/timeline";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { formatNear, hookStatus, oracle } from "@/lib/oracle";
import { cn } from "@/lib/utils";
import { useWallet } from "@/lib/wallet";

/** How often an Assertion still moving (unsettled, or with a Hook in flight) re-reads the contract. */
const REFRESH_MS = 15_000;

/** The `$id` path segment: an Assertion id, a positive integer written in digits. */
const AssertionParams = z.object({
  id: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive()),
});

export const Route = createFileRoute("/assertions/$id")({
  params: {
    parse: (raw) => {
      const parsed = AssertionParams.safeParse(raw);
      if (!parsed.success) throw notFound();
      return parsed.data;
    },
    stringify: ({ id }) => ({ id: String(id) }),
  },
  loader: async ({ params }) => {
    try {
      return { assertion: await oracle.getAssertion(params.id) };
    } catch (error) {
      if (String(error).includes("not found")) throw notFound();
      throw error;
    }
  },
  head: ({ params }) => ({ meta: [{ title: `Assertion ${params.id} · Enzure` }] }),
  component: AssertionPage,
  errorComponent: ({ error }) => <ErrorAlert error={error} title="Couldn't read the Assertion" />,
  notFoundComponent: () => (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon />
        </EmptyMedia>
        <EmptyTitle>No Assertion with this id</EmptyTitle>
        <EmptyDescription>It may not have been posted yet.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
          <ArrowLeftIcon data-icon="inline-start" />
          All Assertions
        </Button>
      </EmptyContent>
    </Empty>
  ),
});

/** NEAR and EVM Hook statuses of a call in flight. */
const IN_FLIGHT = new Set(["delivering", "signing"]);

/** Whether the contract can still change the Assertion without a user acting: unsettled, or a Hook mid-delivery. */
function moving(assertion: OracleAssertion): boolean {
  return (
    assertion.state !== "settled" ||
    (assertion.hooks ?? []).some((hook) => IN_FLIGHT.has(hookStatus(hook)))
  );
}

function AssertionPage() {
  const { assertion } = Route.useLoaderData();
  const router = useRouter();
  const wallet = useWallet();
  const now = useNowNs();
  const refresh = () => void router.invalidate();
  const canDispute = assertion.state === "asserted" && now < BigInt(assertion.liveness_ends_at_ns);
  const appealable = canAppeal(assertion, wallet.accountId, now);
  const live = moving(assertion);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void router.invalidate(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, router]);

  return (
    <>
      <PageHeader
        title={
          <>
            Assertion {assertion.id}
            <StateBadge assertion={assertion} />
          </>
        }
        description={
          <>
            Posted by <Account id={assertion.asserter} /> with a bond of{" "}
            <span className="text-foreground">{formatNear(assertion.bond)}</span>
            {assertion.dispute ? (
              <>
                , disputed by <Account id={assertion.dispute.disputer} />
              </>
            ) : null}
            .
          </>
        }
      />

      {/* One column below lg: status and actions first, since they are time-limited, then the
          content, then the details. From lg the content takes the left column across both rows. */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:grid-rows-[auto_1fr]">
        <div className="flex flex-col gap-6 lg:col-start-2 lg:row-start-1">
          <StatusPanel assertion={assertion} />
          {assertion.state === "in_appeal" && assertion.appeal ? (
            <Card>
              <CardHeader>
                <CardTitle>In Appeal</CardTitle>
                <CardDescription>
                  {appealReason(assertion.appeal)}. The DAO can rule until{" "}
                  <LocalTime ns={assertion.appeal.dao_deadline_ns} /> (
                  <Countdown endsAtNs={assertion.appeal.dao_deadline_ns} ended="passed" />
                  ); after that anyone can settle.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : null}
          {canDispute ? <DisputeCard assertion={assertion} onDisputed={refresh} /> : null}
          {appealable ? <AppealCard assertion={assertion} onAppealed={refresh} /> : null}
        </div>
        <div className="flex min-w-0 flex-col gap-6 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <Card>
            <CardContent>
              <StageTrack stages={stagesOf(assertion, now)} />
            </CardContent>
          </Card>
          <ContentCard assertion={assertion} />
          <Timeline assertion={assertion} onChanged={refresh} />
        </div>
        <div className="lg:col-start-2 lg:row-start-2">
          <FactsCard assertion={assertion} />
        </div>
      </div>
    </>
  );
}

/** The one number that matters right now: time left in the open window, or the outcome. */
function StatusPanel({ assertion }: { assertion: OracleAssertion }) {
  const now = useNowNs();
  const mounted = useMounted();

  if (assertion.state === "settled") {
    const truthful = !!assertion.outcome;
    return (
      <Card>
        <CardContent className="flex items-center gap-4">
          {truthful ? (
            <CheckCircle2Icon className="size-8 text-primary" />
          ) : (
            <XCircleIcon className="size-8 text-destructive" />
          )}
          <div className="flex flex-col gap-1.5">
            <span className="kicker text-muted-foreground">Outcome</span>
            <span
              className={cn(
                "font-heading text-3xl leading-none font-semibold",
                truthful ? "text-primary" : "text-destructive",
              )}
            >
              {truthful ? "TRUE" : "FALSE"}
            </span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const window =
    assertion.state === "asserted"
      ? {
          label: "Liveness ends in",
          start: assertion.asserted_at_ns,
          end: assertion.liveness_ends_at_ns,
        }
      : assertion.state === "ruled" && assertion.appeal_window_ends_at_ns
        ? {
            label: "Appeal Window closes in",
            start: assertion.ai_verdicts[0]?.accepted_at_ns ?? assertion.asserted_at_ns,
            end: assertion.appeal_window_ends_at_ns,
          }
        : assertion.state === "disputed" && assertion.dispute
          ? {
              label: "AI Verdict due in",
              start: assertion.dispute.disputed_at_ns,
              end: assertion.dispute.ai_verdict_deadline_ns,
            }
          : assertion.state === "in_appeal" && assertion.appeal
            ? {
                label: "The DAO can rule for",
                start: assertion.appeal.started_at_ns,
                end: assertion.appeal.dao_deadline_ns,
              }
            : null;

  if (!window || (mounted && now >= BigInt(window.end))) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-1.5">
          <span className="kicker text-muted-foreground">Now</span>
          <span className="font-heading text-2xl font-semibold">Waiting to settle</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <span className="kicker text-muted-foreground">{window.label}</span>
        <span className="font-mono text-3xl leading-none font-medium tracking-tight">
          <Countdown endsAtNs={window.end} ended="Ended" />
        </span>
        <Progress
          aria-label="Time elapsed"
          value={mounted ? windowProgress(window.start, window.end, now) : 0}
        />
      </CardContent>
    </Card>
  );
}

function FactsCard({ assertion }: { assertion: OracleAssertion }) {
  const hooks = assertion.hooks ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col divide-y divide-border text-sm">
          <Fact label="Bond">{formatNear(assertion.bond)}</Fact>
          <Fact label="Asserter">
            <Account id={assertion.asserter} />
          </Fact>
          {assertion.dispute ? (
            <Fact label="Disputer">
              <Account id={assertion.dispute.disputer} />
            </Fact>
          ) : null}
          <Fact label="Posted">
            <LocalTime ns={assertion.asserted_at_ns} />
          </Fact>
          <Fact label="Liveness ends">
            <LocalTime ns={assertion.liveness_ends_at_ns} />
          </Fact>
          {assertion.settled_at_ns ? (
            <Fact label="Settled">
              <LocalTime ns={assertion.settled_at_ns} />
            </Fact>
          ) : null}
          {assertion.prompt_template_version !== null ? (
            <Fact label="Prompt Template">v{assertion.prompt_template_version}</Fact>
          ) : null}
          <Fact label="Hooks">
            {hooks.length === 0
              ? "None"
              : `${hooks.filter((hook) => "near" in hook).length} NEAR, ${hooks.filter((hook) => "evm" in hook).length} EVM`}
          </Fact>
        </dl>
      </CardContent>
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
