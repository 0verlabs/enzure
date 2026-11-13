import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import {
  assertionEvents,
  assertionTimeline,
  fetchAssertionEvents,
  fetchContent,
  nearRpcView,
  putContent,
  type OracleAssertion,
  type ExplorerTransaction,
} from "../src/index.ts";

const ORACLE = "oracle-1794568696.enzure-evm-1794568684.testnet";

/** Real FastNEAR transaction records for the testnet oracle that signed the Chain Signatures fixture. */
const recorded = JSON.parse(
  readFileSync(join(import.meta.dirname, "fastnear-transactions.json"), "utf8"),
) as { transactions: ExplorerTransaction[] };

const POSTED_TX = "J8NNKZoqCXj3uPhwMa1HjojCgRNRvrqJHagaz8j2x9Vs";
const SETTLED_TX = "7L9616LtNafhnKSo3God4NgtBi7wyhVp8fY3uzLywXFW";

type Call = { url: string; init?: RequestInit };

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const rpcResult = (value: unknown) =>
  Response.json({
    jsonrpc: "2.0",
    id: "enzure",
    result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))), logs: [] },
  });

test("a view calls the contract method over NEAR JSON-RPC and parses its JSON result", async () => {
  const { fetch, calls } = fakeFetch(() => rpcResult({ min_bond: "1" }));
  const view = nearRpcView({ rpcUrl: "https://rpc.example", contractId: ORACLE, fetch });

  await expect(view("get_config", { a: 1 })).resolves.toEqual({ min_bond: "1" });

  const body = JSON.parse(calls[0]!.init!.body as string);
  expect(calls[0]!.url).toBe("https://rpc.example");
  expect(body.method).toBe("query");
  expect(body.params).toMatchObject({
    request_type: "call_function",
    finality: "final",
    account_id: ORACLE,
    method_name: "get_config",
  });
  expect(JSON.parse(atob(body.params.args_base64))).toEqual({ a: 1 });
});

test("a view that panics in the contract rejects with the contract's error", async () => {
  const { fetch } = fakeFetch(() =>
    Response.json({
      jsonrpc: "2.0",
      id: "enzure",
      result: {
        error:
          'wasm execution failed with error: FunctionCallError(ExecutionError("Smart contract panicked: Assertion 9 not found"))',
        logs: [],
      },
    }),
  );
  const view = nearRpcView({ rpcUrl: "https://rpc.example", contractId: ORACLE, fetch });

  await expect(view("get_assertion", { assertion_id: 9 })).rejects.toThrow("Assertion 9 not found");
});

test("the oracle's events for one Assertion are found in its transactions, with their hashes", () => {
  expect(assertionEvents(recorded.transactions, ORACLE, 1)).toEqual([
    expect.objectContaining({ event: "assertion_posted", transactionHash: POSTED_TX }),
    expect.objectContaining({ event: "assertion_settled", transactionHash: SETTLED_TX }),
  ]);
  expect(assertionEvents(recorded.transactions, ORACLE, 2)).toEqual([]);
});

test("events logged by another account are not the oracle's", () => {
  const forged = structuredClone(recorded.transactions);
  for (const tx of forged) {
    for (const receipt of tx.receipts)
      receipt.execution_outcome.outcome.executor_id = "mallory.testnet";
  }

  expect(assertionEvents(forged, ORACLE, 1)).toEqual([]);
});

const posted: OracleAssertion = {
  id: 1,
  asserter: "alice.testnet",
  claim_hash: "aa".repeat(32),
  evidence_hash: null,
  bond: "1000000000000000000000000",
  state: "asserted",
  asserted_at_ns: "1000000000000",
  liveness_ends_at_ns: "1060000000000",
  settled_at_ns: null,
  outcome: null,
  hooks: [],
  dispute: null,
  ai_verdicts: [],
  appeal_window_ends_at_ns: null,
};

test("a fresh Assertion's timeline shows it posted and Liveness running", () => {
  expect(assertionTimeline(posted, 1_030_000_000_000n)).toEqual([
    { kind: "posted", atNs: "1000000000000", event: "assertion_posted" },
    { kind: "liveness", endsAtNs: "1060000000000", open: true },
  ]);
});

test("a ruled and settled Assertion's timeline lists each step in order", () => {
  const settled: OracleAssertion = {
    ...posted,
    state: "settled",
    outcome: false,
    settled_at_ns: "1200000000000",
    dispute: {
      disputer: "bob.testnet",
      evidence_hash: "bb".repeat(32),
      seed: 7,
      disputed_at_ns: "1010000000000",
    },
    ai_verdicts: [
      {
        verdict: "FALSE",
        request_hash: "cc".repeat(32),
        response_hash: "dd".repeat(32),
        public_key: "ee".repeat(32),
        accepted_at_ns: "1020000000000",
      },
    ],
    appeal_window_ends_at_ns: "1100000000000",
  };

  expect(assertionTimeline(settled, 1_300_000_000_000n).map((step) => step.kind)).toEqual([
    "posted",
    "liveness",
    "disputed",
    "ai_verdict",
    "appeal_window",
    "settled",
  ]);
  expect(assertionTimeline(settled, 1_300_000_000_000n)).toContainEqual({
    kind: "liveness",
    endsAtNs: "1060000000000",
    open: false,
    disputedAtNs: "1010000000000",
  });
  expect(assertionTimeline(settled, 1_300_000_000_000n)).toContainEqual({
    kind: "ai_verdict",
    atNs: "1020000000000",
    event: "ai_verdict_accepted",
    index: 0,
    verdict: settled.ai_verdicts![0],
  });
  expect(assertionTimeline(settled, 1_300_000_000_000n).at(-1)).toEqual({
    kind: "settled",
    atNs: "1200000000000",
    event: "assertion_settled",
    outcome: false,
  });
});

test("an Assertion's events are read from the explorer: its transaction list, then the transactions", async () => {
  const { fetch, calls } = fakeFetch(({ url }) =>
    url.endsWith("/v0/account")
      ? Response.json({
          account_txs: recorded.transactions.map((tx, index) => ({
            transaction_hash: tx.transaction.hash,
            tx_block_height: 100 - index,
            tx_block_timestamp: "1794568700000000000",
          })),
          txs_count: recorded.transactions.length,
        })
      : Response.json({ transactions: recorded.transactions }),
  );

  const events = await fetchAssertionEvents(
    { apiUrl: "https://tx.example", contractId: ORACLE, fetch },
    { id: 1, asserted_at_ns: "1794568715561325767" },
  );

  expect(events.map((event) => event.transactionHash)).toEqual([POSTED_TX, SETTLED_TX]);
  const lookup = calls.find((call) => call.url === "https://tx.example/v0/transactions");
  expect(JSON.parse(lookup!.init!.body as string).tx_hashes).toHaveLength(3);
});

test("uploading content PUTs its bytes under their sha256 and returns the hash", async () => {
  const { fetch, calls } = fakeFetch(() => Response.json({}, { status: 201 }));

  const hash = await putContent({ storageUrl: "https://storage.example/", fetch }, "hello");

  expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  expect(calls[0]!.url).toBe(`https://storage.example/content/${hash}`);
  expect(calls[0]!.init!.method).toBe("PUT");
});

test("an upload the storage service rejects throws its error", async () => {
  const { fetch } = fakeFetch(() => Response.json({ error: "too_large" }, { status: 413 }));

  await expect(putContent({ storageUrl: "https://storage.example", fetch }, "x")).rejects.toThrow(
    "too_large",
  );
});

test("fetched content is checked against its on-chain hash", async () => {
  const hello = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  const { fetch } = fakeFetch(({ url }) =>
    url.endsWith(hello) ? new Response("hello") : new Response("not found", { status: 404 }),
  );
  const storage = { storageUrl: "https://storage.example", fetch };

  await expect(fetchContent(storage, hello)).resolves.toEqual({ status: "match", text: "hello" });
  await expect(fetchContent(storage, "ab".repeat(32))).resolves.toEqual({ status: "missing" });
});

test("content whose bytes don't hash to the on-chain hash is marked as not matching", async () => {
  const { fetch } = fakeFetch(() => new Response("tampered"));

  await expect(
    fetchContent({ storageUrl: "https://storage.example", fetch }, "ab".repeat(32)),
  ).resolves.toEqual({ status: "mismatch", text: "tampered" });
});
