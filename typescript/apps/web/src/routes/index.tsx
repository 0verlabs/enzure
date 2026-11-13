import { createFileRoute, Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { z } from "zod";
import { StateBadge, Countdown } from "@/components/assertion-bits";
import { BalanceCard } from "@/components/balance-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { missingConfig } from "@/config";
import { formatNear, oracle, PAGE_SIZE, shortHash } from "@/lib/oracle";

export const Route = createFileRoute("/")({
  validateSearch: z.object({ before: z.number().int().positive().optional() }),
  loaderDeps: ({ search }) => ({ before: search.before }),
  loader: async ({ deps }) => ({
    assertions: missingConfig.includes("ORACLE_ACCOUNT_ID")
      ? []
      : await oracle.listAssertions(deps.before),
  }),
  component: Home,
});

function Home() {
  const { assertions } = Route.useLoaderData();
  const { before } = Route.useSearch();
  const last = assertions.at(-1);

  return (
    <>
      <BalanceCard />
      <Card>
        <CardHeader>
          <CardTitle>Assertions</CardTitle>
          <CardDescription>Newest first, read from the oracle contract.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {assertions.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No Assertions yet</EmptyTitle>
                <EmptyDescription>Post the first one.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button asChild>
                  <Link to="/assert">
                    <PlusIcon data-icon="inline-start" />
                    Post an Assertion
                  </Link>
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Claim</TableHead>
                  <TableHead>Asserter</TableHead>
                  <TableHead className="text-right">Bond</TableHead>
                  <TableHead className="text-right">Liveness</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assertions.map((assertion) => (
                  <TableRow key={assertion.id}>
                    <TableCell>
                      <Link
                        to="/assertions/$id"
                        params={{ id: assertion.id }}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {assertion.id}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StateBadge assertion={assertion} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {shortHash(assertion.claim_hash)}
                    </TableCell>
                    <TableCell className="max-w-40 truncate">{assertion.asserter}</TableCell>
                    <TableCell className="text-right">{formatNear(assertion.bond, 2)}</TableCell>
                    <TableCell className="text-right">
                      {assertion.state === "asserted" ? (
                        <Countdown endsAtNs={assertion.liveness_ends_at_ns} />
                      ) : (
                        "–"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <div className="flex justify-between">
            {before ? (
              <Button variant="outline" size="sm" asChild>
                <Link to="/" search={{}}>
                  Newest
                </Link>
              </Button>
            ) : (
              <span />
            )}
            {last && assertions.length === PAGE_SIZE && last.id > 1 ? (
              <Button variant="outline" size="sm" asChild>
                <Link to="/" search={{ before: last.id }}>
                  Older
                </Link>
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
