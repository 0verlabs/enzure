import { canAppeal, type OracleAssertion } from "@enzure/core";
import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { Account, Countdown, StateBadge, useNowNs } from "@/components/assertion-bits";
import { AppealCard } from "@/components/appeal-card";
import { ContentCard } from "@/components/content-card";
import { DisputeCard } from "@/components/dispute-card";
import { ErrorAlert } from "@/components/error-alert";
import { Timeline, appealReason } from "@/components/timeline";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNear, formatTime, oracle } from "@/lib/oracle";
import { useWallet } from "@/lib/wallet";

/** How often an Assertion still moving (unsettled, or with a Hook in flight) re-reads the contract. */
const REFRESH_MS = 15_000;

export const Route = createFileRoute("/assertions/$id")({
  params: {
    parse: ({ id }) => {
      if (!/^\d+$/.test(id)) throw notFound();
      return { id: Number(id) };
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
    <p className="text-muted-foreground">There is no Assertion with this id.</p>
  ),
});

/** Whether the contract can still change the Assertion without a user acting: unsettled, or a Hook mid-delivery. */
function moving(assertion: OracleAssertion): boolean {
  return (
    assertion.state !== "settled" ||
    (assertion.hooks ?? []).some((hook) =>
      "near" in hook ? hook.near.status === "delivering" : hook.evm.status === "signing",
    )
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
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3 text-xl">
            Assertion {assertion.id}
            <StateBadge assertion={assertion} />
          </CardTitle>
          <CardDescription>
            Posted by <Account id={assertion.asserter} /> with a bond of{" "}
            {formatNear(assertion.bond)}
            {assertion.dispute ? (
              <>
                , disputed by <Account id={assertion.dispute.disputer} />
              </>
            ) : null}
            .
          </CardDescription>
        </CardHeader>
      </Card>
      {assertion.state === "in_appeal" && assertion.appeal ? (
        <Card>
          <CardHeader>
            <CardTitle>In Appeal</CardTitle>
            <CardDescription>
              {appealReason(assertion.appeal)}. The DAO can rule until{" "}
              {formatTime(assertion.appeal.dao_deadline_ns)} (
              <Countdown endsAtNs={assertion.appeal.dao_deadline_ns} ended="passed" />
              ); after that anyone can settle.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}
      {canDispute ? <DisputeCard assertion={assertion} onDisputed={refresh} /> : null}
      {appealable ? <AppealCard assertion={assertion} onAppealed={refresh} /> : null}
      <Timeline assertion={assertion} onChanged={refresh} />
      <ContentCard assertion={assertion} />
    </>
  );
}
