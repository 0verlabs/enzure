import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import {
  assertionEvents,
  daoProposalId,
  fetchProposalTransaction,
  type ExplorerTransaction,
} from "../src/index.ts";

const ORACLE = "oracle-1794575543.enzure-council-a-1794575224.testnet";
const DAO = "enzure-1794575224.sputnikv2.testnet";

/** Real FastNEAR records: the DAO's proposals 2 and 3, and the vote that approved proposal 3 (`resolve_appeal` for Assertion 1). */
const recorded = JSON.parse(
  readFileSync(join(import.meta.dirname, "fastnear-dao-transactions.json"), "utf8"),
) as { transactions: ExplorerTransaction[] };

const VOTE_TX = "BQysmRoouCcBBF4hhfRftkbGdycssxykDoZ1DwAk9JZj";
const PROPOSAL_3_TX = "FzBRNoJQnbKj8DZWSvQkpkds6R1jMK7ZE5u5yJndyoNZ";

const ruling = () => assertionEvents(recorded.transactions, ORACLE, 1)[0]!;

test("the DAO's ruling names the proposal whose approval carried it", () => {
  expect(ruling()).toMatchObject({ event: "appeal_resolved", transactionHash: VOTE_TX });
  expect(daoProposalId(ruling(), DAO)).toBe(3);
});

test("a ruling not sent through the oracle's DAO names no proposal", () => {
  expect(daoProposalId(ruling(), "another-dao.sputnikv2.testnet")).toBeNull();
});

function fakeExplorer() {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(url.toString()).pathname;
    const body = JSON.parse(init!.body as string);
    requests.push({ path, body });
    if (path === "/v0/account") {
      return Response.json({
        account_txs: recorded.transactions.map((tx, index) => ({
          transaction_hash: tx.transaction.hash,
          tx_block_height: 277514822 - index,
          tx_block_timestamp: "1794575788965735270",
        })),
      });
    }
    return Response.json({
      transactions: recorded.transactions.filter((tx) =>
        (body.tx_hashes as string[]).includes(tx.transaction.hash),
      ),
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

test("a proposal's transaction is the DAO's add_proposal that returned its id", async () => {
  const { fetch, requests } = fakeExplorer();

  const found = await fetchProposalTransaction(
    { apiUrl: "https://tx.example", contractId: DAO, fetch },
    { proposalId: 3, sinceNs: "1794575779942704741", maxBlockHeight: 277514823 },
  );

  expect(found).toEqual({
    transactionHash: PROPOSAL_3_TX,
    proposer: "enzure-council-b-1794575224.testnet",
    description: "Rule Assertion 1 under Appeal: TRUE.",
  });
  expect(requests[0]).toEqual({
    path: "/v0/account",
    body: { account_id: DAO, max_block_height: 277514823 },
  });
});

test("a proposal the DAO's transactions don't include isn't found", async () => {
  const { fetch } = fakeExplorer();

  await expect(
    fetchProposalTransaction(
      { apiUrl: "https://tx.example", contractId: DAO, fetch },
      { proposalId: 9, sinceNs: "1794575779942704741", maxBlockHeight: 277514823 },
    ),
  ).resolves.toBeNull();
});
