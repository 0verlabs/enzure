import {
  assertionTimeline,
  fetchAssertionEvents,
  losingParty,
  timelineTransactions,
  type AppealView,
  type OracleAssertion,
  type OracleEvent,
  type TimelineStep,
} from "@enzure/core";
import { useEffect, useState, type ReactNode } from "react";
import { Account, Countdown, LocalTime, TxLink, useNowNs } from "@/components/assertion-bits";
import { DaoRulingDetail } from "@/components/dao-ruling";
import { EvmHookDetail, NearHookDetail } from "@/components/hook-delivery";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { config } from "@/config";
import { formatNear, hookStatus, shortHash } from "@/lib/oracle";
import { cn } from "@/lib/utils";

interface StepView {
  title: string;
  /** When it happened or ends. */
  at?: ReactNode;
  detail?: ReactNode;
  /** A timer still running. */
  open?: boolean;
  /** Text before the step's transaction link. */
  linkLabel?: string;
}

/** What a step's view can read besides the step: the Assertion, its events, and a way to re-read both. */
interface StepContext {
  assertion: OracleAssertion;
  events: readonly OracleEvent[] | null;
  onChanged: () => void;
}

/** Why an Assertion went to Appeal, as one line. */
export function appealReason(appeal: AppealView): ReactNode {
  switch (appeal.reason) {
    case "appealed":
      return (
        <>
          Appealed by {appeal.appellant ? <Account id={appeal.appellant} /> : "the losing party"}
          {appeal.appeal_bond ? (
            <> with an appeal bond of {formatNear(appeal.appeal_bond)}</>
          ) : null}
        </>
      );
    case "conflicting":
      return "Conflicting Verdicts";
    case "unresolvable":
      return "The AI Verdict was UNRESOLVABLE";
    case "no_verdict":
      return "No AI Verdict arrived before its deadline";
  }
}

/**
 * How each kind of timeline step is shown. Steps come from core's
 * `assertionTimeline`; a new kind there gets an entry here and a transaction
 * link through its `event`.
 */
const STEP_VIEWS: {
  [K in TimelineStep["kind"]]: (
    step: Extract<TimelineStep, { kind: K }>,
    context: StepContext,
  ) => StepView;
} = {
  posted: (step) => ({ title: "Posted", at: <LocalTime ns={step.atNs} /> }),
  liveness: (step) =>
    step.open
      ? {
          title: "Liveness running",
          at: (
            <>
              ends <LocalTime ns={step.endsAtNs} />
            </>
          ),
          detail: (
            <>
              <Countdown endsAtNs={step.endsAtNs} /> left to dispute
            </>
          ),
          open: true,
        }
      : step.disputedAtNs
        ? { title: "Liveness stopped by a dispute", at: <LocalTime ns={step.disputedAtNs} /> }
        : { title: "Liveness ended", at: <LocalTime ns={step.endsAtNs} /> },
  disputed: (step) => ({
    title: "Disputed",
    at: <LocalTime ns={step.atNs} />,
    detail: (
      <>
        by <Account id={step.dispute.disputer} />, AI request seed {step.dispute.seed}
      </>
    ),
  }),
  ai_verdict: (step) => ({
    title: `AI Verdict ${step.index + 1}`,
    at: <LocalTime ns={step.atNs} />,
    detail: (
      <span className="flex flex-wrap items-center gap-2">
        <Badge variant={step.verdict.verdict === "TRUE" ? "default" : "secondary"}>
          {step.verdict.verdict}
        </Badge>
        <span className="font-mono text-xs">
          signed by {shortHash(step.verdict.public_key)}, response{" "}
          {shortHash(step.verdict.response_hash)}
        </span>
      </span>
    ),
  }),
  appeal_window: (step, { assertion }) => {
    if (step.open) {
      const loser = losingParty(assertion);
      return {
        title: "Appeal Window open",
        at: (
          <>
            closes <LocalTime ns={step.endsAtNs} />
          </>
        ),
        detail: (
          <>
            <Countdown endsAtNs={step.endsAtNs} /> left
            {loser ? (
              <>
                {" "}
                for <Account id={loser} /> to appeal
              </>
            ) : null}
          </>
        ),
        open: true,
      };
    }
    return step.appealedAtNs
      ? {
          title: "Appeal Window closed by the move to Appeal",
          at: <LocalTime ns={step.appealedAtNs} />,
        }
      : { title: "Appeal Window closed", at: <LocalTime ns={step.endsAtNs} /> };
  },
  appeal: (step) => ({
    title: "In Appeal",
    at: <LocalTime ns={step.atNs} />,
    detail: (
      <span className="flex flex-col gap-1">
        <span>{appealReason(step.appeal)}.</span>
        {step.conflictingVerdicts ? (
          <span className="flex flex-wrap items-center gap-2">
            The AI Verdicts disagreed:
            <Badge variant="secondary">{step.conflictingVerdicts[0]}</Badge>
            then
            <Badge variant="secondary">{step.conflictingVerdicts[1]}</Badge>
          </span>
        ) : null}
        <span>
          The DAO can rule until <LocalTime ns={step.appeal.dao_deadline_ns} />.
        </span>
      </span>
    ),
  }),
  dao_deadline: (step) =>
    step.open
      ? {
          title: "Waiting for the DAO",
          at: (
            <>
              deadline <LocalTime ns={step.endsAtNs} />
            </>
          ),
          detail: (
            <>
              <Countdown endsAtNs={step.endsAtNs} /> left for the DAO to rule; after that anyone can
              settle
            </>
          ),
          open: true,
        }
      : {
          title: "DAO deadline passed without a ruling",
          at: <LocalTime ns={step.endsAtNs} />,
          detail:
            "Anyone can settle: an appealed AI Verdict stands; otherwise the outcome is FALSE and both bonds are returned.",
        },
  dao_ruling: (step, { assertion, events }) => ({
    title: "DAO ruled",
    at: <LocalTime ns={step.atNs} />,
    linkLabel: "Approved in",
    detail: assertion.appeal ? (
      <DaoRulingDetail outcome={step.outcome} appeal={assertion.appeal} events={events} />
    ) : null,
  }),
  settled: (step) => ({
    title: "Settled",
    at: <LocalTime ns={step.atNs} />,
    detail: (
      <Badge variant={step.outcome ? "default" : "destructive"}>
        {step.outcome ? "TRUE" : "FALSE"}
      </Badge>
    ),
  }),
  near_hook: (step, { assertion, onChanged }) => ({
    title: `NEAR Hook ${step.hookIndex + 1}`,
    detail: <NearHookDetail assertionId={assertion.id} step={step} onChanged={onChanged} />,
    open: step.status !== "delivered",
    linkLabel: step.status === "delivered" ? "Delivered in" : "Last attempt failed in",
  }),
  evm_hook: (step, { assertion, onChanged }) => ({
    title: `EVM Hook ${step.hookIndex + 1}`,
    linkLabel: "Signed on NEAR in",
    detail: <EvmHookDetail assertionId={assertion.id} step={step} onChanged={onChanged} />,
  }),
};

function viewOf(step: TimelineStep, context: StepContext): StepView {
  return (STEP_VIEWS[step.kind] as (step: TimelineStep, context: StepContext) => StepView)(
    step,
    context,
  );
}

/** The oracle's events for an Assertion, read in the browser from the transaction API. */
export function useAssertionEvents(assertion: OracleAssertion) {
  const [events, setEvents] = useState<OracleEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Re-read when the Assertion moves on, so new steps get their links.
  const hooks = (assertion.hooks ?? []).map(hookStatus).join(",");
  const key = `${assertion.id}:${assertion.state}:${assertion.ai_verdicts?.length ?? 0}:${hooks}`;
  useEffect(() => {
    let cancelled = false;
    fetchAssertionEvents({ apiUrl: config.txApiUrl, contractId: config.oracleAccountId }, assertion)
      .then((found) => !cancelled && setEvents(found))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [key]);
  return { events, failed };
}

export function Timeline({
  assertion,
  onChanged,
}: {
  assertion: OracleAssertion;
  /** Called after a Hook action from the timeline, to re-read the Assertion. */
  onChanged: () => void;
}) {
  const now = useNowNs();
  const steps = assertionTimeline(assertion, now);
  const { events, failed } = useAssertionEvents(assertion);
  const hashes = timelineTransactions(steps, events ?? []);
  const context = { assertion, events, onChanged };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
        <CardDescription>
          Read from the contract; transaction links come from the NEAR {config.network} transaction
          API{failed ? " (unavailable right now)" : ""}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col">
          {steps.map((step, index) => {
            const view = viewOf(step, context);
            const hash = hashes[index];
            const lastStep = index === steps.length - 1;
            return (
              <li key={`${step.kind}-${index}`} className="flex gap-4">
                <div className="flex flex-col items-center">
                  <span className="relative mt-1 flex size-5 shrink-0 items-center justify-center">
                    {view.open ? (
                      <>
                        <span className="ping-soft absolute inset-0.5 rounded-full bg-primary/40" />
                        <span className="relative size-3 rounded-full border-2 border-primary bg-background" />
                      </>
                    ) : (
                      <span className="flex size-5 items-center justify-center rounded-full bg-primary/15">
                        <span className="size-2 rounded-full bg-primary" />
                      </span>
                    )}
                  </span>
                  {!lastStep ? (
                    <span
                      className={cn("my-1 w-px flex-1", view.open ? "bg-primary/50" : "bg-border")}
                    />
                  ) : null}
                </div>
                <div className={cn("flex min-w-0 flex-1 flex-col gap-1.5", !lastStep && "pb-7")}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="font-medium">{view.title}</span>
                    {view.at ? (
                      <span className="font-mono text-xs text-muted-foreground">{view.at}</span>
                    ) : null}
                  </div>
                  {view.detail ? (
                    <div className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
                      {view.detail}
                    </div>
                  ) : null}
                  {"event" in step && step.event ? (
                    hash ? (
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        {view.linkLabel ? <>{view.linkLabel} </> : null}
                        <TxLink hash={hash} />
                      </span>
                    ) : events === null && !failed ? (
                      <Spinner className="size-3 text-muted-foreground" />
                    ) : null
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
