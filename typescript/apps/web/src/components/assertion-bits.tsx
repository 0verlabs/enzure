import type { OracleAssertion } from "@enzure/core";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { transactionUrl } from "@/config";
import { shortHash } from "@/lib/oracle";

const STATE_LABELS: Record<string, string> = {
  asserted: "In Liveness",
  disputed: "Disputed",
  ruled: "Ruled",
  in_appeal: "In Appeal",
  settled: "Settled",
};

/** The Assertion's state, with its outcome once settled. */
export function StateBadge({ assertion }: { assertion: OracleAssertion }) {
  if (assertion.state === "settled") {
    return (
      <Badge variant={assertion.outcome ? "default" : "destructive"}>
        Settled {assertion.outcome ? "TRUE" : "FALSE"}
      </Badge>
    );
  }
  if (assertion.state === "asserted" && nowNs() >= BigInt(assertion.liveness_ends_at_ns)) {
    return <Badge variant="secondary">Liveness ended</Badge>;
  }
  return <Badge variant="outline">{STATE_LABELS[assertion.state] ?? assertion.state}</Badge>;
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

/** A live countdown to `endsAtNs`, rendered only in the browser so it matches the server's HTML. */
export function Countdown({ endsAtNs, ended = "ended" }: { endsAtNs: string; ended?: string }) {
  const now = useNowNs();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <span className="tabular-nums">…</span>;
  return <span className="tabular-nums">{timeLeft(endsAtNs, now) ?? ended}</span>;
}

/** A link to a NEAR transaction in the explorer. */
export function TxLink({ hash }: { hash: string }) {
  return (
    <a
      href={transactionUrl(hash)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
    >
      {shortHash(hash)}
      <ExternalLinkIcon className="size-3" />
    </a>
  );
}
