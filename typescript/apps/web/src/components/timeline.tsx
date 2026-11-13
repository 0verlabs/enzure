import {
  assertionTimeline,
  fetchAssertionEvents,
  timelineTransactions,
  type OracleAssertion,
  type OracleEvent,
  type TimelineStep,
} from "@enzure/core";
import { useEffect, useState, type ReactNode } from "react";
import { Countdown, TxLink, useNowNs } from "@/components/assertion-bits";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { accountUrl, config } from "@/config";
import { formatTime, shortHash } from "@/lib/oracle";

interface StepView {
  title: string;
  /** When it happened or ends. */
  at: ReactNode;
  detail?: ReactNode;
  /** A timer still running. */
  open?: boolean;
}

/**
 * How each kind of timeline step is shown. Steps come from core's
 * `assertionTimeline`; a new kind there (Appeal, Hook delivery) gets an entry
 * here and a transaction link through its `event`.
 */
const STEP_VIEWS: {
  [K in TimelineStep["kind"]]: (step: Extract<TimelineStep, { kind: K }>) => StepView;
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
  appeal_window: (step) =>
    step.open
      ? {
          title: "Appeal Window open",
          at: <>closes {formatTime(step.endsAtNs)}</>,
          detail: (
            <>
              <Countdown endsAtNs={step.endsAtNs} /> left to appeal
            </>
          ),
          open: true,
        }
      : { title: "Appeal Window closed", at: formatTime(step.endsAtNs) },
  settled: (step) => ({
    title: "Settled",
    at: formatTime(step.atNs),
    detail: (
      <Badge variant={step.outcome ? "default" : "destructive"}>
        {step.outcome ? "TRUE" : "FALSE"}
      </Badge>
    ),
  }),
};

function viewOf(step: TimelineStep): StepView {
  return (STEP_VIEWS[step.kind] as (step: TimelineStep) => StepView)(step);
}

/** The oracle's events for an Assertion, read in the browser from the transaction API. */
export function useAssertionEvents(assertion: OracleAssertion) {
  const [events, setEvents] = useState<OracleEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Re-read when the Assertion moves on, so new steps get their links.
  const key = `${assertion.id}:${assertion.state}:${assertion.ai_verdicts?.length ?? 0}`;
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

export function Timeline({ assertion }: { assertion: OracleAssertion }) {
  const now = useNowNs();
  const steps = assertionTimeline(assertion, now);
  const { events, failed } = useAssertionEvents(assertion);
  const hashes = timelineTransactions(steps, events ?? []);

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
            const view = viewOf(step);
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
                    <span className="text-xs text-muted-foreground">{view.at}</span>
                  </div>
                  {view.detail ? (
                    <div className="text-sm text-muted-foreground">{view.detail}</div>
                  ) : null}
                  {"event" in step ? (
                    hash ? (
                      <TxLink hash={hash} />
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

export function Account({ id }: { id: string }) {
  return (
    <a
      href={accountUrl(id)}
      target="_blank"
      rel="noreferrer"
      className="underline-offset-4 hover:underline"
    >
      {id}
    </a>
  );
}
