import type { OracleAssertion } from "@enzure/core";
import { Countdown, TxLink } from "@/components/assertion-bits";
import { ErrorAlert } from "@/components/error-alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { CALL_GAS, formatNear } from "@/lib/oracle";
import { useOracleAction } from "@/lib/oracle-action";

/**
 * Appeals a ruled Assertion to the DAO with an appeal bond equal to the
 * Assertion's bond. The page shows it only to the party that lost the AI
 * Verdict, while the Appeal Window is open.
 */
export function AppealCard({
  assertion,
  onAppealed,
}: {
  assertion: OracleAssertion;
  onAppealed: () => void;
}) {
  const { pending, error, sent, run } = useOracleAction(onAppealed);
  const verdict = assertion.ai_verdicts[0]?.verdict;

  const appeal = () =>
    run({
      method: "appeal",
      args: { assertion_id: assertion.id },
      deposit: assertion.bond,
      gas: CALL_GAS,
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appeal to the DAO</CardTitle>
        <CardDescription>
          The AI Verdict went against you ({verdict}). Appeal it to the DAO within{" "}
          <Countdown endsAtNs={assertion.appeal_window_ends_at_ns!} /> with an appeal bond of{" "}
          {formatNear(assertion.bond)}. You get the appeal bond back if the DAO rules for you, or if
          it doesn&apos;t rule in time.
        </CardDescription>
      </CardHeader>
      <CardFooter className="flex flex-col items-stretch gap-4">
        {error ? <ErrorAlert error={error} title="Appeal failed" /> : null}
        {sent ? (
          <p className="text-sm">
            Appealed in <TxLink hash={sent.hash} />
          </p>
        ) : null}
        <div className="flex flex-col">
          <Button
            variant="destructive"
            size="lg"
            className="h-10"
            disabled={pending}
            onClick={appeal}
          >
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {pending ? "Confirm in your wallet…" : `Appeal with ${formatNear(assertion.bond)}`}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
