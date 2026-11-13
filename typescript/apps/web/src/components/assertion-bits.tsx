import type { AssertionState, OracleAssertion } from "@enzure/core";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { accountUrl, evmTransactionUrl, transactionUrl } from "@/config";
import { formatTime, shortHash } from "@/lib/oracle";
import { cn } from "@/lib/utils";

const STATE_LABELS: Record<AssertionState, string> = {
  asserted: "In Liveness",
  disputed: "Disputed",
  ruled: "Ruled",
  in_appeal: "In Appeal",
  settled: "Settled",
};

/** The dot colour of each open state, from the theme's chart blues. */
const STATE_DOTS: Record<Exclude<AssertionState, "settled">, string> = {
  asserted: "bg-primary",
  disputed: "bg-chart-2",
  ruled: "bg-chart-3",
  in_appeal: "bg-chart-1",
};

/** The Assertion's state, with its outcome once settled. */
export function StateBadge({
  assertion,
  className,
}: {
  assertion: OracleAssertion;
  className?: string;
}) {
  if (assertion.state === "settled") {
    return (
      <Badge variant={assertion.outcome ? "default" : "destructive"} className={className}>
        Settled {assertion.outcome ? "TRUE" : "FALSE"}
      </Badge>
    );
  }
  if (assertion.state === "asserted" && nowNs() >= BigInt(assertion.liveness_ends_at_ns)) {
    return (
      <Badge variant="secondary" className={className}>
        Liveness ended
      </Badge>
    );
  }
  const live = assertion.state === "asserted";
  return (
    <Badge variant="outline" className={className}>
      <span className="relative flex size-1.5">
        {live ? (
          <span className={cn("ping-soft absolute inset-0 rounded-full", STATE_DOTS.asserted)} />
        ) : null}
        <span className={cn("relative size-1.5 rounded-full", STATE_DOTS[assertion.state])} />
      </span>
      {STATE_LABELS[assertion.state] ?? assertion.state}
    </Badge>
  );
}

export function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

/** The current time in nanoseconds, updated every second in the browser. */
export function useNowNs(): bigint {
  const [now, setNow] = useState(nowNs);
  useEffect(() => {
    const timer = setInterval(() => setNow(nowNs()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** False on the server and in the first browser render, so time-based output matches the server's HTML. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/** Time left until `endsAtNs`, as `1h 02m 03s`, or null once it has passed. */
export function timeLeft(endsAtNs: string, now: bigint): string | null {
  const seconds = Number((BigInt(endsAtNs) - now) / 1_000_000_000n);
  if (seconds <= 0) return null;
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return d > 0
    ? `${d}d ${h}h ${pad(m)}m`
    : h > 0
      ? `${h}h ${pad(m)}m ${pad(s)}s`
      : `${m}m ${pad(s)}s`;
}

/** How far through the window from `startNs` to `endsAtNs` it is now, 0 to 100. */
export function windowProgress(startNs: string, endsAtNs: string, now: bigint): number {
  const start = BigInt(startNs);
  const span = BigInt(endsAtNs) - start;
  if (span <= 0n) return 100;
  const done = Number(((now - start) * 1000n) / span) / 10;
  return Math.min(100, Math.max(0, done));
}

/** A live countdown to `endsAtNs`, rendered only in the browser so it matches the server's HTML. */
export function Countdown({ endsAtNs, ended = "ended" }: { endsAtNs: string; ended?: string }) {
  const now = useNowNs();
  const mounted = useMounted();
  if (!mounted) return <span className="tabular-nums">…</span>;
  return <span className="tabular-nums">{timeLeft(endsAtNs, now) ?? ended}</span>;
}

/** A time in the reader's own time zone, written after hydration: the Worker renders in UTC. */
export function LocalTime({ ns }: { ns: string | bigint }) {
  const mounted = useMounted();
  return <span className="tabular-nums">{mounted ? formatTime(ns) : "…"}</span>;
}

/** `5 minutes ago`, `3 days ago`, for a past time in nanoseconds. */
export function timeAgo(ns: string, now: bigint): string {
  const seconds = Number((now - BigInt(ns)) / 1_000_000_000n);
  const units = [
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ] as const;
  for (const [unit, size] of units) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

export function Account({ id, className }: { id: string; className?: string }) {
  return (
    <a
      href={accountUrl(id)}
      target="_blank"
      rel="noreferrer"
      className={cn("break-all text-foreground underline-offset-4 hover:underline", className)}
    >
      {id}
    </a>
  );
}

/** A link to a NEAR transaction in the explorer. */
export function TxLink({ hash }: { hash: string }) {
  return <HashLink href={transactionUrl(hash)} hash={hash} />;
}

/** A link to a transaction on the EVM chain (Base Sepolia) in its explorer. */
export function EvmTxLink({ hash }: { hash: string }) {
  return <HashLink href={evmTransactionUrl(hash)} hash={hash} />;
}

function HashLink({ href, hash }: { href: string; hash: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded-sm font-mono text-xs text-primary transition-colors hover:text-foreground"
    >
      {shortHash(hash)}
      <ExternalLinkIcon className="size-3" />
    </a>
  );
}
