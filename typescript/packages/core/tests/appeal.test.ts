import { expect, test } from "vite-plus/test";
import { canAppeal, type OracleAssertion } from "../src/index.ts";

const ruled = (verdict: string): OracleAssertion => ({
  id: 1,
  asserter: "alice.testnet",
  claim_hash: "aa".repeat(32),
  evidence_hash: null,
  bond: "1000000000000000000000000",
  state: "ruled",
  asserted_at_ns: "1000000000000",
  liveness_ends_at_ns: "1060000000000",
  settled_at_ns: null,
  outcome: null,
  hooks: [],
  prompt_template_version: 1,
  dispute: {
    disputer: "bob.testnet",
    evidence_hash: null,
    seed: 7,
    disputed_at_ns: "1010000000000",
    ai_verdict_deadline_ns: "1070000000000",
  },
  ai_verdicts: [
    {
      verdict,
      request_hash: "cc".repeat(32),
      response_hash: "dd".repeat(32),
      public_key: "ee".repeat(32),
      accepted_at_ns: "1020000000000",
    },
  ],
  appeal_window_ends_at_ns: "1080000000000",
  appeal: null,
});

const during = 1_050_000_000_000n;

test("after a TRUE AI Verdict only the Disputer can Appeal, during the Appeal Window", () => {
  expect(canAppeal(ruled("TRUE"), "bob.testnet", during)).toBe(true);
  expect(canAppeal(ruled("TRUE"), "alice.testnet", during)).toBe(false);
  expect(canAppeal(ruled("TRUE"), "carol.testnet", during)).toBe(false);
  expect(canAppeal(ruled("TRUE"), null, during)).toBe(false);
});

test("after a FALSE AI Verdict only the Asserter can Appeal", () => {
  expect(canAppeal(ruled("FALSE"), "alice.testnet", during)).toBe(true);
  expect(canAppeal(ruled("FALSE"), "bob.testnet", during)).toBe(false);
});

test("nobody can Appeal once the Appeal Window has closed or the Assertion moved on", () => {
  expect(canAppeal(ruled("FALSE"), "alice.testnet", 1_080_000_000_000n)).toBe(false);
  expect(canAppeal({ ...ruled("FALSE"), state: "in_appeal" }, "alice.testnet", during)).toBe(false);
  expect(canAppeal({ ...ruled("FALSE"), state: "settled" }, "alice.testnet", during)).toBe(false);
});
