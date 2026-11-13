import { expect, test } from "vite-plus/test";
import {
  checkSignedResult,
  evmHooksToRelay,
  evmHooksToSign,
  type SignedResultView,
} from "../src/index.ts";
import { chainSignatures as fixture } from "./fixture.ts";

const signed = (): SignedResultView => structuredClone(fixture.signed_result);

test("a signed result from the testnet oracle checks out against its derived address", () => {
  expect(checkSignedResult(signed(), fixture.address)).toEqual({ ok: true });
});

test("a signed result is checked against any case of the oracle address", () => {
  expect(checkSignedResult(signed(), fixture.address.toUpperCase().replace("0X", "0x"))).toEqual({
    ok: true,
  });
});

test("a signed result is rejected for another oracle", () => {
  expect(checkSignedResult(signed(), "0x2000000000000000000000000000000000000002")).toEqual({
    ok: false,
    reason: "not signed by the oracle",
  });
});

test("a signed result with a changed field is rejected", () => {
  const changed = { ...signed(), outcome: false };

  expect(checkSignedResult(changed, fixture.address)).toEqual({
    ok: false,
    reason: "not signed by the oracle",
  });
});

test("a signed result whose asserter hash doesn't match the asserter is rejected", () => {
  const changed = { ...signed(), asserter: "mallory.testnet" };

  expect(checkSignedResult(changed, fixture.address)).toEqual({
    ok: false,
    reason: "asserter_hash does not match asserter",
  });
});

test("a malformed signature is rejected without throwing", () => {
  const changed = { ...signed(), v: 30 };

  expect(checkSignedResult(changed, fixture.address)).toEqual({
    ok: false,
    reason: "invalid signature",
  });
});

const receiver = "0x1000000000000000000000000000000000000001";
const consumer = "0x2000000000000000000000000000000000000002";
const evmHook = (status: string, chainId = 84532) => ({
  evm: { chain_id: chainId, receiver, consumer, status },
});
const nearHook = { near: { consumer: "consumer.testnet", gas: "20000000000000", status: "failed" } };
const assertion = (id: number, state: string, hooks: object[]) => ({
  id,
  asserter: "alice.testnet",
  claim_hash: "64a5dddb88128a31ba9a3c719b73d55160a125423dff298529c354abb204dd2a",
  evidence_hash: null,
  bond: "1000000000000000000000000",
  state,
  asserted_at_ns: "1794568700000000000",
  liveness_ends_at_ns: "1794568760000000000",
  settled_at_ns: state === "settled" ? "1794568779000000000" : null,
  outcome: state === "settled" ? true : null,
  hooks,
});

test("the Scheduler signs every unsigned EVM Hook of a settled Assertion", () => {
  const assertions = [
    assertion(3, "settled", [nearHook, evmHook("unsigned"), evmHook("signed"), evmHook("unsigned", 1)]),
    assertion(2, "asserted", [evmHook("unsigned")]),
    assertion(1, "settled", [evmHook("signing"), evmHook("unsigned")]),
  ];

  expect(evmHooksToSign(assertions)).toEqual([
    { assertionId: 3, hookIndex: 1, chainId: 84532, receiver, consumer },
    { assertionId: 3, hookIndex: 3, chainId: 1, receiver, consumer },
    { assertionId: 1, hookIndex: 1, chainId: 84532, receiver, consumer },
  ]);
});

test("the Relayer picks up signed EVM Hooks for its chain only", () => {
  const assertions = [
    assertion(2, "settled", [evmHook("signed"), evmHook("signed", 1), nearHook, evmHook("unsigned")]),
    assertion(1, "settled", [evmHook("signing"), evmHook("signed")]),
  ];

  expect(evmHooksToRelay(assertions, 84532)).toEqual([
    { assertionId: 2, hookIndex: 0, chainId: 84532, receiver, consumer },
    { assertionId: 1, hookIndex: 1, chainId: 84532, receiver, consumer },
  ]);
});
