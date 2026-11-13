import type { AssertionView, OracleView } from "./relayer.ts";

/**
 * Reading the oracle: its views over NEAR JSON-RPC, an Assertion's timeline,
 * and the transactions behind each step, found through a public transaction
 * explorer API (there is no indexer of our own).
 */

/** An Assertion's state, as the oracle's `State` enum serializes it. */
export type AssertionState = "asserted" | "disputed" | "ruled" | "in_appeal" | "settled";

/** A dispute as `get_assertion` returns it. */
export interface DisputeView {
  disputer: string;
  /** sha256 of the Disputer's Evidence, lowercase hex, or null if none. */
  evidence_hash: string | null;
  seed: number;
  disputed_at_ns: string;
  /** With no AI Verdict by this time, anyone can call `check_timeout`. Fixed at dispute time. */
  ai_verdict_deadline_ns: string;
}

/** An accepted AI Verdict as `get_assertion` returns it. */
export interface AiVerdictView {
  verdict: "TRUE" | "FALSE" | "UNRESOLVABLE" | (string & {});
  request_hash: string;
  response_hash: string;
  public_key: string;
  accepted_at_ns: string;
}

/** An Appeal as `get_assertion` returns it. It stays set after the Assertion settles. */
export interface AppealView {
  reason: "appealed" | "conflicting" | "unresolvable" | "no_verdict";
  /** The party that appealed with a bond; null unless `reason` is `appealed`. */
  appellant: string | null;
  /** The appeal bond in yoctoNEAR; null unless `reason` is `appealed`. */
  appeal_bond: string | null;
  started_at_ns: string;
  /** The DAO can rule until this time; from then on anyone can `settle`. */
  dao_deadline_ns: string;
}

/**
 * An Assertion with every field `get_assertion` and `list_assertions` return.
 * Amounts are yoctoNEAR and timestamps nanoseconds since the Unix epoch, as
 * decimal strings.
 */
export interface OracleAssertion extends AssertionView {
  asserter: string;
  claim_hash: string;
  evidence_hash: string | null;
  bond: string;
  state: AssertionState;
  asserted_at_ns: string;
  liveness_ends_at_ns: string;
  settled_at_ns: string | null;
  outcome: boolean | null;
  prompt_template_version: number | null;
  dispute: DisputeView | null;
  /** Oldest first; two after Conflicting Verdicts. */
  ai_verdicts: readonly AiVerdictView[];
  /** Set once a TRUE or FALSE first AI Verdict is accepted. */
  appeal_window_ends_at_ns: string | null;
  /** Set once the Assertion goes to Appeal. */
  appeal: AppealView | null;
}

export interface NearRpcOptions {
  rpcUrl: string;
  contractId: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * An `OracleView` that calls the contract's view methods over NEAR JSON-RPC
 * at final finality. A contract panic rejects with the RPC's error text.
 */
export function nearRpcView({
  rpcUrl,
  contractId,
  fetch = globalThis.fetch,
}: NearRpcOptions): OracleView {
  return async <T>(method: string, args: Record<string, unknown>): Promise<T> => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "enzure",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: contractId,
          method_name: method,
          args_base64: bytesToBase64(utf8.encode(JSON.stringify(args))),
        },
      }),
    });
    if (!response.ok) throw new Error(`NEAR RPC ${method}: HTTP ${response.status}`);
    const body = (await response.json()) as {
      error?: { message?: string; data?: unknown; cause?: { name?: string } };
      result?: { result?: number[]; error?: string };
    };
    if (body.error) {
      throw new Error(
        `NEAR RPC ${method}: ${body.error.cause?.name ?? body.error.message ?? "error"} ${JSON.stringify(body.error.data ?? "")}`,
      );
    }
    if (body.result?.error) throw new Error(`${method}: ${body.result.error}`);
    if (!body.result?.result) throw new Error(`NEAR RPC ${method}: no result`);
    return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result))) as T;
  };
}

/** One step of an Assertion's timeline. `event` names the oracle event that records it. */
export type TimelineStep =
  | { kind: "posted"; atNs: string; event: "assertion_posted" }
  | { kind: "liveness"; endsAtNs: string; open: boolean; disputedAtNs?: string }
  | { kind: "disputed"; atNs: string; event: "assertion_disputed"; dispute: DisputeView }
  | {
      kind: "ai_verdict";
      atNs: string;
      event: "ai_verdict_accepted";
      index: number;
      verdict: AiVerdictView;
    }
  | { kind: "appeal_window"; endsAtNs: string; open: boolean; appealedAtNs?: string }
  | {
      kind: "appeal";
      atNs: string;
      event: "appeal_started";
      appeal: AppealView;
      /** The first and second AI Verdict, when they conflicted. */
      conflictingVerdicts?: [string, string];
    }
  /** The DAO's deadline to rule, shown while it runs and when it passed without a ruling. */
  | { kind: "dao_deadline"; endsAtNs: string; open: boolean }
  | { kind: "dao_ruling"; atNs: string; event: "appeal_resolved"; outcome: boolean }
  | { kind: "settled"; atNs: string; event: "assertion_settled"; outcome: boolean };

/**
 * The steps an Assertion has gone through, oldest first, as of `nowNs`:
 * posting, Liveness, dispute, each AI Verdict, the Appeal Window, the move to
 * Appeal with the DAO's deadline or ruling, and settlement. Steps that haven't
 * happened are left out; open timers are marked `open`.
 */
export function assertionTimeline(assertion: OracleAssertion, nowNs: bigint): TimelineStep[] {
  const settled = assertion.state === "settled";
  const appeal = assertion.appeal ?? null;
  const steps: TimelineStep[] = [
    { kind: "posted", atNs: assertion.asserted_at_ns, event: "assertion_posted" },
  ];
  const dispute = assertion.dispute ?? null;
  steps.push({
    kind: "liveness",
    endsAtNs: assertion.liveness_ends_at_ns,
    open: assertion.state === "asserted" && nowNs < BigInt(assertion.liveness_ends_at_ns),
    ...(dispute ? { disputedAtNs: dispute.disputed_at_ns } : {}),
  });
  if (dispute) {
    steps.push({
      kind: "disputed",
      atNs: dispute.disputed_at_ns,
      event: "assertion_disputed",
      dispute,
    });
  }
  (assertion.ai_verdicts ?? []).forEach((verdict, index) => {
    steps.push({
      kind: "ai_verdict",
      atNs: verdict.accepted_at_ns,
      event: "ai_verdict_accepted",
      index,
      verdict,
    });
  });
  if (assertion.appeal_window_ends_at_ns) {
    steps.push({
      kind: "appeal_window",
      endsAtNs: assertion.appeal_window_ends_at_ns,
      // Only a ruled Assertion can still be appealed; an Appeal or settlement closes the window.
      open: assertion.state === "ruled" && nowNs < BigInt(assertion.appeal_window_ends_at_ns),
      ...(appeal ? { appealedAtNs: appeal.started_at_ns } : {}),
    });
  }
  if (appeal) {
    const [first, second] = assertion.ai_verdicts ?? [];
    steps.push({
      kind: "appeal",
      atNs: appeal.started_at_ns,
      event: "appeal_started",
      appeal,
      ...(appeal.reason === "conflicting" && first && second
        ? { conflictingVerdicts: [first.verdict, second.verdict] as [string, string] }
        : {}),
    });
    // The DAO can only rule before its deadline and `settle` only works from it on.
    const ruled =
      settled &&
      assertion.settled_at_ns !== null &&
      BigInt(assertion.settled_at_ns) < BigInt(appeal.dao_deadline_ns);
    if (ruled && assertion.outcome !== null) {
      steps.push({
        kind: "dao_ruling",
        atNs: assertion.settled_at_ns!,
        event: "appeal_resolved",
        outcome: assertion.outcome,
      });
    } else {
      steps.push({
        kind: "dao_deadline",
        endsAtNs: appeal.dao_deadline_ns,
        open: !settled && nowNs < BigInt(appeal.dao_deadline_ns),
      });
    }
  }
  if (settled && assertion.settled_at_ns && assertion.outcome !== null) {
    steps.push({
      kind: "settled",
      atNs: assertion.settled_at_ns,
      event: "assertion_settled",
      outcome: assertion.outcome,
    });
  }
  return steps;
}

/**
 * The party that lost the first AI Verdict and so may Appeal it: the Disputer
 * after TRUE, the Asserter after FALSE. Null without a TRUE or FALSE verdict.
 */
export function losingParty(assertion: OracleAssertion): string | null {
  const first = assertion.ai_verdicts?.[0]?.verdict;
  if (first === "TRUE") return assertion.dispute?.disputer ?? null;
  if (first === "FALSE") return assertion.asserter;
  return null;
}

/**
 * Whether `accountId` can call `appeal` at `nowNs`: it lost the AI Verdict of
 * a ruled Assertion whose Appeal Window is still open.
 */
export function canAppeal(
  assertion: OracleAssertion,
  accountId: string | null,
  nowNs: bigint,
): boolean {
  return (
    accountId !== null &&
    assertion.state === "ruled" &&
    assertion.appeal_window_ends_at_ns !== null &&
    nowNs < BigInt(assertion.appeal_window_ends_at_ns) &&
    losingParty(assertion) === accountId
  );
}

/** A transaction as the FastNEAR transactions API returns it; only the fields read here. */
export interface ExplorerTransaction {
  transaction: { hash: string; signer_id: string; receiver_id: string };
  receipts: Array<{
    execution_outcome: {
      block_height: number;
      outcome: { executor_id: string; logs: string[] };
    };
  }>;
}

/** An oracle event (NEP-297, standard `enzure`) and the transaction that emitted it. */
export interface OracleEvent {
  event: string;
  data: Record<string, unknown>;
  transactionHash: string;
  /** Height of the block whose receipt logged it. */
  blockHeight: number;
}

const EVENT_PREFIX = "EVENT_JSON:";

/**
 * The oracle's events about one Assertion in `transactions`, oldest first.
 * Only logs from receipts the oracle itself executed count, so another
 * contract can't forge them.
 */
export function assertionEvents(
  transactions: readonly ExplorerTransaction[],
  contractId: string,
  assertionId: number,
): OracleEvent[] {
  const events: OracleEvent[] = [];
  for (const tx of transactions) {
    for (const receipt of tx.receipts) {
      const { block_height: blockHeight, outcome } = receipt.execution_outcome;
      const { executor_id, logs } = outcome;
      if (executor_id !== contractId) continue;
      for (const log of logs) {
        if (!log.startsWith(EVENT_PREFIX)) continue;
        let parsed: { standard?: string; event?: string; data?: Record<string, unknown> };
        try {
          parsed = JSON.parse(log.slice(EVENT_PREFIX.length));
        } catch {
          continue;
        }
        if (parsed.standard !== "enzure" || !parsed.event || !parsed.data) continue;
        if (parsed.data.assertion_id !== assertionId) continue;
        events.push({
          event: parsed.event,
          data: parsed.data,
          transactionHash: tx.transaction.hash,
          blockHeight,
        });
      }
    }
  }
  // Stable, so events logged by one receipt keep their order.
  return events.sort((a, b) => a.blockHeight - b.blockHeight);
}

export interface ExplorerOptions {
  /** FastNEAR transactions API, e.g. `https://tx.test.fastnear.com`. */
  apiUrl: string;
  contractId: string;
  fetch?: typeof globalThis.fetch;
}

/** How far before `asserted_at_ns` the posting transaction can be: its receipt runs a block or more later. */
const POSTING_SLACK_NS = 120_000_000_000n;
const TRANSACTIONS_PER_REQUEST = 20;

/**
 * The oracle's events about one Assertion, oldest first, read from the
 * FastNEAR transactions API: the oracle's transactions since the Assertion was
 * posted, then those transactions' receipts and logs.
 */
export async function fetchAssertionEvents(
  { apiUrl, contractId, fetch = globalThis.fetch }: ExplorerOptions,
  assertion: Pick<OracleAssertion, "id" | "asserted_at_ns">,
): Promise<OracleEvent[]> {
  const base = apiUrl.replace(/\/$/, "");
  const since = BigInt(assertion.asserted_at_ns) - POSTING_SLACK_NS;
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return (await response.json()) as T;
  };

  // The account's transactions come newest first, a page at a time.
  const hashes: string[] = [];
  for (let maxBlockHeight: number | undefined; ;) {
    const page = await post<{
      account_txs: Array<{
        transaction_hash: string;
        tx_block_height: number;
        tx_block_timestamp: string;
      }>;
    }>("/v0/account", {
      account_id: contractId,
      ...(maxBlockHeight === undefined ? {} : { max_block_height: maxBlockHeight }),
    });
    const recent = page.account_txs.filter((tx) => BigInt(tx.tx_block_timestamp) >= since);
    const fresh = recent.filter((tx) => !hashes.includes(tx.transaction_hash));
    hashes.push(...fresh.map((tx) => tx.transaction_hash));
    const last = page.account_txs.at(-1);
    // Stop at the first page that reaches back before the posting, or adds nothing new.
    if (!last || fresh.length === 0 || recent.length < page.account_txs.length) break;
    maxBlockHeight = last.tx_block_height - 1;
  }

  const transactions: ExplorerTransaction[] = [];
  for (let i = 0; i < hashes.length; i += TRANSACTIONS_PER_REQUEST) {
    const { transactions: batch } = await post<{ transactions: ExplorerTransaction[] }>(
      "/v0/transactions",
      { tx_hashes: hashes.slice(i, i + TRANSACTIONS_PER_REQUEST) },
    );
    transactions.push(...batch);
  }
  return assertionEvents(transactions, contractId, assertion.id);
}

const utf8 = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The transaction hash behind each timeline step, or null for timers and for
 * steps whose event isn't in `events` (yet). A step's event is the n-th event
 * of its name, where n is the step's `index` (0 if it has none), so the second
 * AI Verdict gets the second `ai_verdict_accepted`.
 */
export function timelineTransactions(
  steps: readonly TimelineStep[],
  events: readonly OracleEvent[],
): (string | null)[] {
  return steps.map((step) => {
    if (!("event" in step)) return null;
    const index = "index" in step ? step.index : 0;
    return events.filter((event) => event.event === step.event)[index]?.transactionHash ?? null;
  });
}
