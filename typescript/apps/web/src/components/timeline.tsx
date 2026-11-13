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
import { Account, Countdown, TxLink, useNowNs } from "@/components/assertion-bits";
import { DaoRulingDetail } from "@/components/dao-ruling";
import { EvmHookDetail, NearHookDetail } from "@/components/hook-delivery";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { config } from "@/config";
import { formatNear, formatTime, shortHash } from "@/lib/oracle";

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
  posted: (step) => ({ title: "Posted", at: formatTime(step.atNs) }),
  liveness: (step) =>
    step.open
      ? {
          title: "Liveness running",
          at: <>ends {formatTime(step.endsAtNs)}</>,
          detail: (
            <>
              <Countdown endsAtNs={step.endsAtNs} /> left to dispute
            </>
          ),
          open: true,
        }
      : step.disputedAtNs
        ? { title: "Liveness stopped by a dispute", at: formatTime(step.disputedAtNs) }
        : { title: "Liveness ended", at: formatTime(step.endsAtNs) },
  disputed: (step) => ({
    title: "Disputed",
    at: formatTime(step.atNs),
    detail: (
      <>
        by <Account id={step.dispute.disputer} />, AI request seed {step.dispute.seed}
      </>
    ),
  }),
  ai_verdict: (step) => ({
    title: `AI Verdict ${step.index + 1}`,
    at: formatTime(step.atNs),
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
        at: <>closes {formatTime(step.endsAtNs)}</>,
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
      ? { title: "Appeal Window closed by the move to Appeal", at: formatTime(step.appealedAtNs) }
      : { title: "Appeal Window closed", at: formatTime(step.endsAtNs) };
  },
  appeal: (step) => ({
    title: "In Appeal",
    at: formatTime(step.atNs),
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
        <span>The DAO can rule until {formatTime(step.appeal.dao_deadline_ns)}.</span>
      </span>
    ),
  }),
  dao_deadline: (step) =>
    step.open
      ? {
          title: "Waiting for the DAO",
          at: <>deadline {formatTime(step.endsAtNs)}</>,
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
          at: formatTime(step.endsAtNs),
          detail:
            "Anyone can settle: an appealed AI Verdict stands; otherwise the outcome is FALSE and both bonds are returned.",
        },
  dao_ruling: (step, { assertion, events }) => ({
    title: "DAO ruled",
    at: formatTime(step.atNs),
    linkLabel: "Approved in",
    detail: assertion.appeal ? (
      <DaoRulingDetail outcome={step.outcome} appeal={assertion.appeal} events={events} />
    ) : null,
  }),
  settled: (step) => ({
    title: "Settled",
    at: formatTime(step.atNs),
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
  const hooks = (assertion.hooks ?? [])
    .map((hook) => ("near" in hook ? hook.near.status : hook.evm.status))
    .join(",");
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
            return (
              <li key={`${step.kind}-${index}`} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className={
                      view.open
                        ? "mt-1.5 size-2.5 rounded-full border-2 border-primary"
                        : "mt-1.5 size-2.5 rounded-full bg-primary"
                    }
                  />
                  {index < steps.length - 1 ? <span className="w-px flex-1 bg-border" /> : null}
                </div>
                <div className="flex flex-1 flex-col gap-1 pb-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                    <span className="font-medium">{view.title}</span>
                    {view.at ? (
                      <span className="text-xs text-muted-foreground">{view.at}</span>
                    ) : null}
                  </div>
                  {view.detail ? (
                    <div className="text-sm text-muted-foreground">{view.detail}</div>
                  ) : null}
                  {"event" in step && step.event ? (
                    hash ? (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
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
