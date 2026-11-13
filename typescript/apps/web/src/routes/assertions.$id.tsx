import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { StateBadge, useNowNs } from "@/components/assertion-bits";
import { ContentCard } from "@/components/content-card";
import { DisputeCard } from "@/components/dispute-card";
import { ErrorAlert } from "@/components/error-alert";
import { Account, Timeline } from "@/components/timeline";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNear, oracle } from "@/lib/oracle";

/** How often an unsettled Assertion's page re-reads the contract. */
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

function AssertionPage() {
  const { assertion } = Route.useLoaderData();
  const router = useRouter();
  const now = useNowNs();
  const settled = assertion.state === "settled";
  const canDispute = assertion.state === "asserted" && now < BigInt(assertion.liveness_ends_at_ns);

  useEffect(() => {
    if (settled) return;
    const timer = setInterval(() => void router.invalidate(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [settled, router]);

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
      {canDispute ? (
        <DisputeCard assertion={assertion} onDisputed={() => void router.invalidate()} />
      ) : null}
      <Timeline assertion={assertion} />
      <ContentCard assertion={assertion} />
    </>
  );
}
