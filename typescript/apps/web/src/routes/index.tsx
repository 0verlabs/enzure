import type { OracleAssertion } from "@enzure/core";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon, InboxIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import {
  Countdown,
  StateBadge,
  timeAgo,
  useMounted,
  useNowNs,
  windowProgress,
} from "@/components/assertion-bits";
import { PageHeader } from "@/components/page-header";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { missingConfig } from "@/config";
import { formatNear, oracle, PAGE_SIZE, shortHash } from "@/lib/oracle";

export const Route = createFileRoute("/")({
  validateSearch: z.object({ before: z.number().int().positive().optional() }),
  loaderDeps: ({ search }) => ({ before: search.before }),
  loader: async ({ deps }) => {
    if (missingConfig.includes("ORACLE_ACCOUNT_ID")) {
      return { assertions: [], latest: null, minBond: null };
    }
    const [assertions, latest, oracleConfig] = await Promise.all([
      oracle.listAssertions(deps.before),
      deps.before === undefined ? null : oracle.latestAssertion(),
      oracle.getConfig().catch(() => null),
    ]);
    return {
      assertions,
      latest: latest ?? (deps.before === undefined ? (assertions[0] ?? null) : null),
      minBond: oracleConfig?.min_bond ?? null,
    };
  },
  component: Home,
});

type Filter = "all" | "open" | "resolving" | "settled";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Undisputed" },
  { value: "resolving", label: "Disputed" },
  { value: "settled", label: "Settled" },
];

/** Which filter an Assertion falls under: undisputed and unsettled, disputed and unsettled, or settled. */
function filterOf(assertion: OracleAssertion): Exclude<Filter, "all"> {
  if (assertion.state === "settled") return "settled";
  return assertion.state === "asserted" ? "open" : "resolving";
}

function Home() {
  const { assertions, latest, minBond } = Route.useLoaderData();
  const { before } = Route.useSearch();
  const now = useNowNs();
  const mounted = useMounted();
  const [filter, setFilter] = useState<Filter>("all");

  // Only Liveness still running counts as open to dispute; time-based, so counted after hydration.
  const disputable = assertions.filter(
    (assertion) => assertion.state === "asserted" && now < BigInt(assertion.liveness_ends_at_ns),
  ).length;
  const resolving = assertions.filter((assertion) => filterOf(assertion) === "resolving").length;
  const shown =
    filter === "all"
      ? assertions
      : assertions.filter((assertion) => filterOf(assertion) === filter);
  const last = assertions.at(-1);
  const older = last && assertions.length === PAGE_SIZE && last.id > 1 ? last.id : null;
  const range = assertions.length > 0 ? `${assertions[0]!.id}–${assertions.at(-1)!.id}` : null;

  return (
    <>
      <PageHeader
        title="Assertions"
        description="Bonded Claims on the oracle, newest first, read from the contract. Open one to dispute it or follow it to settlement."
        actions={
          <Button nativeButton={false} render={<Link to="/assert" />}>
            <PlusIcon data-icon="inline-start" />
            Post an Assertion
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Posted" value={latest ? String(latest.id) : "0"} note="Assertions in total" />
        <Stat
          label="In Liveness"
          value={mounted ? String(disputable) : "–"}
          note={`Open to dispute, of these ${assertions.length}`}
        />
        <Stat label="Disputed" value={String(resolving)} note="AI Verdict or Appeal pending" />
        <Stat
          label="Minimum bond"
          value={minBond ? formatNear(minBond, 2) : "–"}
          note="Liveness 1 min to 7 days"
        />
      </div>

      <Card className="gap-0 py-0">
        <CardHeader className="flex flex-col gap-3 border-b py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <CardTitle>Recent Assertions</CardTitle>
            <CardDescription>
              {range ? `Assertions ${range}` : "Nothing posted yet"}
            </CardDescription>
          </div>
          <ToggleGroup
            aria-label="Filter by state"
            variant="outline"
            spacing={0}
            value={[filter]}
            onValueChange={(value) => value[0] && setFilter(value[0] as Filter)}
          >
            {FILTERS.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value}>
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </CardHeader>
        <CardContent className="px-0">
          {shown.length === 0 ? (
            <Empty className="py-14">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <InboxIcon />
                </EmptyMedia>
                <EmptyTitle>
                  {assertions.length === 0 ? "No Assertions yet" : "None in this view"}
                </EmptyTitle>
                <EmptyDescription>
                  {assertions.length === 0
                    ? "Post the first Claim and its bond."
                    : "Try another filter, or the older page."}
                </EmptyDescription>
              </EmptyHeader>
              {assertions.length === 0 ? (
                <EmptyContent>
                  <Button nativeButton={false} render={<Link to="/assert" />}>
                    <PlusIcon data-icon="inline-start" />
                    Post an Assertion
                  </Button>
                </EmptyContent>
              ) : null}
            </Empty>
          ) : (
            <AssertionTable assertions={shown} />
          )}
        </CardContent>
        {before || older !== null ? (
          <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
            {before ? (
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link to="/" search={{}} />}
              >
                <ChevronLeftIcon data-icon="inline-start" />
                Newest
              </Button>
            ) : null}
            {older !== null ? (
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link to="/" search={{ before: older }} />}
              >
                Older
                <ChevronRightIcon data-icon="inline-end" />
              </Button>
            ) : null}
          </div>
        ) : null}
      </Card>
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <span className="font-heading text-3xl font-semibold tabular-nums">{value}</span>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{note}</CardContent>
    </Card>
  );
}

function AssertionTable({ assertions }: { assertions: OracleAssertion[] }) {
  const navigate = useNavigate();
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-16 pl-4">ID</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Claim</TableHead>
          <TableHead className="hidden lg:table-cell">Asserter</TableHead>
          <TableHead className="text-right">Bond</TableHead>
          <TableHead className="hidden w-48 md:table-cell">Liveness</TableHead>
          <TableHead className="hidden w-8 pr-4 sm:table-cell" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {assertions.map((assertion) => (
          <TableRow
            key={assertion.id}
            className="cursor-pointer"
            onClick={() => void navigate({ to: "/assertions/$id", params: { id: assertion.id } })}
          >
            <TableCell className="pl-4">
              <Link
                to="/assertions/$id"
                params={{ id: assertion.id }}
                className="font-mono font-medium hover:underline"
                onClick={(event) => event.stopPropagation()}
              >
                {assertion.id}
              </Link>
            </TableCell>
            <TableCell>
              <StateBadge assertion={assertion} />
            </TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">
              {shortHash(assertion.claim_hash)}
            </TableCell>
            <TableCell className="hidden max-w-56 truncate lg:table-cell">
              {assertion.asserter}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatNear(assertion.bond, 2)}
            </TableCell>
            <TableCell className="hidden md:table-cell">
              <RowTime assertion={assertion} />
            </TableCell>
            <TableCell className="hidden pr-4 text-muted-foreground sm:table-cell">
              <ChevronRightIcon className="size-4" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Liveness left with a bar while it runs; otherwise when the Assertion settled or was posted. */
function RowTime({ assertion }: { assertion: OracleAssertion }) {
  const now = useNowNs();
  const mounted = useMounted();
  if (!mounted) return <span className="text-xs text-muted-foreground">…</span>;
  const open = assertion.state === "asserted" && now < BigInt(assertion.liveness_ends_at_ns);
  if (open) {
    return (
      <span className="flex flex-col gap-1.5">
        <span className="text-xs">
          <Countdown endsAtNs={assertion.liveness_ends_at_ns} /> left
        </span>
        <Progress
          aria-label="Liveness elapsed"
          value={windowProgress(assertion.asserted_at_ns, assertion.liveness_ends_at_ns, now)}
        />
      </span>
    );
  }
  return (
    <span className="text-xs text-muted-foreground">
      {assertion.settled_at_ns
        ? `Settled ${timeAgo(assertion.settled_at_ns, now)}`
        : `Posted ${timeAgo(assertion.asserted_at_ns, now)}`}
    </span>
  );
}
