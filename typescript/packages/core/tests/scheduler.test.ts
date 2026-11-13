import { expect, test } from "vite-plus/test";
import { dueCalls, type OracleAssertion } from "../src/index.ts";

const SEC = 1_000_000_000n;
const T0 = 1_794_568_700n * SEC;

/** An Assertion as `list_assertions` returns it, posted at T0 with 60 s Liveness. */
function assertion(id: number, overrides: Partial<OracleAssertion> = {}): OracleAssertion {
  return {
    id,
    asserter: "alice.testnet",
    claim_hash: "64a5dddb88128a31ba9a3c719b73d55160a125423dff298529c354abb204dd2a",
    evidence_hash: null,
    bond: "1000000000000000000000000",
    state: "asserted",
    asserted_at_ns: String(T0),
    liveness_ends_at_ns: String(T0 + 60n * SEC),
    settled_at_ns: null,
    outcome: null,
    hooks: [],
    prompt_template_version: 1,
    dispute: null,
    ai_verdicts: [],
    appeal_window_ends_at_ns: null,
    appeal: null,
    ...overrides,
  };
}

const disputed = (id: number, disputedAt: bigint) =>
  assertion(id, {
    state: "disputed",
    dispute: {
      disputer: "bob.testnet",
      evidence_hash: null,
      seed: 7,
      disputed_at_ns: String(disputedAt),
      ai_verdict_deadline_ns: String(disputedAt + 3_600n * SEC),
    },
  });

const ruled = (id: number, appealWindowEnds: bigint) =>
  assertion(id, {
    ...disputed(id, T0 + 10n * SEC),
    state: "ruled",
    ai_verdicts: [
      {
        verdict: "TRUE",
        request_hash: "aa".repeat(32),
        response_hash: "bb".repeat(32),
        public_key: "cc".repeat(32),
        accepted_at_ns: String(T0 + 20n * SEC),
      },
    ],
    appeal_window_ends_at_ns: String(appealWindowEnds),
  });

const settle = (assertionId: number) => ({
  method: "settle",
  args: { assertion_id: assertionId },
  gas: "300000000000000",
  deposit: "0",
});

test("an undisputed Assertion is due to settle from the end of Liveness, not before", () => {
  const assertions = [assertion(1)];

  expect(dueCalls(assertions, { nowNs: T0 + 60n * SEC - 1n })).toEqual([]);
  expect(dueCalls(assertions, { nowNs: T0 + 60n * SEC })).toEqual([settle(1)]);
});

test("a ruled Assertion is due to settle from the end of its Appeal Window, not before", () => {
  const assertions = [ruled(4, T0 + 600n * SEC)];

  expect(dueCalls(assertions, { nowNs: T0 + 600n * SEC - 1n })).toEqual([]);
  expect(dueCalls(assertions, { nowNs: T0 + 600n * SEC })).toEqual([settle(4)]);
});

test("settled and disputed Assertions are never due to settle", () => {
  const assertions = [
    assertion(2, { state: "settled", settled_at_ns: String(T0 + 61n * SEC), outcome: true }),
    disputed(3, T0 + 10n * SEC),
  ];

  expect(dueCalls(assertions, { nowNs: T0 + 1_000_000n * SEC })).toEqual([]);
});

test("a disputed Assertion with no AI Verdict is due for check_timeout once the AI Verdict deadline has passed", () => {
  const assertions = [disputed(5, T0 + 10n * SEC)];
  const timeout = {
    method: "check_timeout",
    args: { assertion_id: 5 },
    gas: "300000000000000",
    deposit: "0",
  };

  expect(
    dueCalls(assertions, { nowNs: T0 + 3_610n * SEC - 1n, aiVerdictDeadlineSecs: 3_600 }),
  ).toEqual([]);
  expect(dueCalls(assertions, { nowNs: T0 + 3_610n * SEC, aiVerdictDeadlineSecs: 3_600 })).toEqual([
    timeout,
  ]);
});

test("check_timeout is never due while the oracle has no AI Verdict deadline", () => {
  expect(dueCalls([disputed(5, T0)], { nowNs: T0 + 1_000_000n * SEC })).toEqual([]);
});

test("unsigned EVM Hooks of settled Assertions are due for sign_hook with its gas and deposit", () => {
  const evm = (status: string) => ({
    evm: {
      chain_id: 84532,
      receiver: "0x1000000000000000000000000000000000000001",
      consumer: "0x2000000000000000000000000000000000000002",
      status,
    },
  });
  const assertions = [
    assertion(6, { state: "settled", outcome: true, hooks: [evm("signed"), evm("unsigned")] }),
  ];

  expect(dueCalls(assertions, { nowNs: T0 })).toEqual([
    {
      method: "sign_hook",
      args: { assertion_id: 6, hook_index: 1 },
      gas: "300000000000000",
      deposit: "1",
    },
  ]);
});
