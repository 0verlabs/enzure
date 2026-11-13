import { fetchContent, type FetchedContent, type OracleAssertion } from "@enzure/core";
import { CheckCircle2Icon, XCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { config } from "@/config";

type Item = { label: string; hash: string | null };

/**
 * The Claim and both Evidence items, fetched from storage in the browser and
 * checked against the hashes the contract holds.
 */
export function ContentCard({ assertion }: { assertion: OracleAssertion }) {
  const items: Item[] = [
    { label: "Claim", hash: assertion.claim_hash },
    { label: "Asserter's Evidence", hash: assertion.evidence_hash },
    ...(assertion.dispute
      ? [{ label: "Disputer's Evidence", hash: assertion.dispute.evidence_hash }]
      : []),
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Claim and Evidence</CardTitle>
        <CardDescription>
          Fetched from storage; each is checked against the sha256 hash on-chain.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {items.map((item, index) => (
          <div key={item.label} className="flex flex-col gap-4">
            {index > 0 ? <Separator /> : null}
            <ContentItem item={item} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ContentItem({ item }: { item: Item }) {
  const [content, setContent] = useState<
    FetchedContent | { status: "error"; message: string } | null
  >(null);

  useEffect(() => {
    if (!item.hash) return;
    let cancelled = false;
    fetchContent({ storageUrl: config.storageUrl }, item.hash)
      .then((found) => !cancelled && setContent(found))
      .catch(
        (error: unknown) => !cancelled && setContent({ status: "error", message: String(error) }),
      );
    return () => {
      cancelled = true;
    };
  }, [item.hash]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{item.label}</span>
        {item.hash ? <HashStatus content={content} /> : null}
      </div>
      {item.hash ? (
        <>
          <code className="text-xs break-all text-muted-foreground">sha256 {item.hash}</code>
          {content === null ? (
            <Skeleton className="h-16 w-full" />
          ) : "text" in content ? (
            <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">
              {content.text}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">
              {content.status === "missing"
                ? "Storage has nothing under this hash."
                : `Couldn't read storage: ${content.message}`}
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">None given.</p>
      )}
    </div>
  );
}

function HashStatus({ content }: { content: FetchedContent | { status: "error" } | null }) {
  if (content === null) return null;
  if (content.status === "match") {
    return (
      <Badge variant="secondary">
        <CheckCircle2Icon data-icon="inline-start" />
        Matches hash
      </Badge>
    );
  }
  if (content.status === "mismatch") {
    return (
      <Badge variant="destructive">
        <XCircleIcon data-icon="inline-start" />
        Does not match hash
      </Badge>
    );
  }
  return <Badge variant="outline">Not available</Badge>;
}
