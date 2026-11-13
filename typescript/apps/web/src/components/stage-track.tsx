import type { OracleAssertion } from "@enzure/core";
import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type StageState = "done" | "current" | "skipped" | "ahead";

interface Stage {
  label: string;
  state: StageState;
}

/** Where the Assertion stands on its path: which stages it passed, is in, skipped, or has ahead. */
export function stagesOf(assertion: OracleAssertion, now: bigint): Stage[] {
  const settled = assertion.state === "settled";
  const livenessOpen =
    assertion.state === "asserted" && now < BigInt(assertion.liveness_ends_at_ns);
  const disputed = !!assertion.dispute;
  const verdicts = assertion.ai_verdicts?.length ?? 0;
  const windowOpen =
    assertion.state === "ruled" &&
    !!assertion.appeal_window_ends_at_ns &&
    now < BigInt(assertion.appeal_window_ends_at_ns);
  const pass = (done: boolean, current: boolean, skipped: boolean): StageState =>
    done ? "done" : current ? "current" : skipped ? "skipped" : "ahead";
  const noDispute = !disputed && (settled || !livenessOpen);

  return [
    { label: "Posted", state: "done" },
    { label: "Liveness", state: livenessOpen ? "current" : "done" },
    { label: "Dispute", state: pass(disputed, false, noDispute) },
    {
      label: "AI Verdict",
      state: pass(
        verdicts > 0,
        disputed && verdicts === 0 && !assertion.appeal,
        noDispute || settled || !!assertion.appeal,
      ),
    },
    {
      label: assertion.appeal ? "Appeal" : windowOpen ? "Appeal Window" : "Appeal",
      state: assertion.appeal
        ? settled
          ? "done"
          : "current"
        : windowOpen
          ? "current"
          : pass(false, false, settled || noDispute),
    },
    { label: "Settled", state: settled ? "done" : "ahead" },
  ];
}

export function StageTrack({ stages }: { stages: Stage[] }) {
  return (
    <ol className="grid grid-cols-3 gap-x-2 gap-y-5 sm:grid-cols-6" aria-label="Stages">
      {stages.map((stage, index) => (
        <li key={stage.label} className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "relative flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
                stage.state === "done" && "border-primary bg-primary text-primary-foreground",
                stage.state === "current" && "border-primary text-primary",
                stage.state === "skipped" && "border-dashed border-border text-muted-foreground",
                stage.state === "ahead" && "border-border text-muted-foreground",
              )}
            >
              {stage.state === "current" ? (
                <span className="ping-soft absolute inset-0 rounded-full border border-primary" />
              ) : null}
              {stage.state === "done" ? <CheckIcon className="size-3.5" /> : index + 1}
            </span>
            <span
              aria-hidden
              className={cn(
                "h-px flex-1",
                stage.state === "done" ? "bg-primary/60" : "bg-border",
                index === stages.length - 1 && "invisible",
              )}
            />
          </div>
          <span className="flex flex-col">
            <span
              className={cn(
                "text-sm font-medium",
                stage.state === "skipped" || stage.state === "ahead"
                  ? "text-muted-foreground"
                  : "text-foreground",
              )}
            >
              {stage.label}
            </span>
            <span className="text-xs text-muted-foreground">
              {stage.state === "done"
                ? "Done"
                : stage.state === "current"
                  ? "Now"
                  : stage.state === "skipped"
                    ? "Skipped"
                    : "Ahead"}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}
