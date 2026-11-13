import { expect, test } from "vite-plus/test";
import {
  encodeResultMessage,
  evmAddressFromPublicKey,
  recoverEvmSigner,
  resultMessageDigest,
  type ResultMessage,
} from "../src/index.ts";
import { bytesToHex } from "../src/signature.ts";
import { chainSignatures as fixture } from "./fixture.ts";

const signed = fixture.signed_result;
const fromFixture = (): ResultMessage => ({
  chainId: BigInt(signed.chain_id),
  receiver: signed.receiver,
  consumer: signed.consumer,
  assertionId: BigInt(signed.assertion_id),
  outcome: signed.outcome,
  claimHash: signed.claim_hash,
  asserter: signed.asserter,
  settledAt: BigInt(signed.settled_at),
});
const hex = (bytes: Uint8Array) => `0x${bytesToHex(bytes)}`;

test("the testnet result message encodes to the bytes and digest the oracle signed", () => {
  const message = fromFixture();

  expect(hex(encodeResultMessage(message))).toBe(signed.message);
  expect(hex(resultMessageDigest(message))).toBe(signed.digest);
});

test("the version tag and the Asserter's hash are their own words", () => {
  const encoded = encodeResultMessage(fromFixture());

  expect(encoded).toHaveLength(9 * 32);
  expect(hex(encoded.slice(0, 32))).toBe(signed.version);
  expect(hex(encoded.slice(7 * 32, 8 * 32))).toBe(signed.asserter_hash);
});

test("any changed field changes the digest", () => {
  const digest = hex(resultMessageDigest(fromFixture()));
  const changes: Partial<ResultMessage>[] = [
    { chainId: 1n },
    { receiver: "0x1000000000000000000000000000000000000002" },
    { consumer: "0x2000000000000000000000000000000000000003" },
    { assertionId: 2n },
    { outcome: false },
    { claimHash: `0x${"00".repeat(32)}` },
    { asserter: "someone-else.testnet" },
    { settledAt: 1n },
  ];
  for (const change of changes) {
    expect(hex(resultMessageDigest({ ...fromFixture(), ...change }))).not.toBe(digest);
  }
});

test("the testnet signature recovers to the oracle's derived address", () => {
  const digest = resultMessageDigest(fromFixture());

  expect(evmAddressFromPublicKey(fixture.public_key)).toBe(fixture.address);
  expect(recoverEvmSigner(digest, signed)).toBe(fixture.address);
  expect(recoverEvmSigner(digest, { ...signed, v: signed.v === 27 ? 28 : 27 })).not.toBe(
    fixture.address,
  );
});

test("a malformed address is rejected", () => {
  expect(() => encodeResultMessage({ ...fromFixture(), receiver: "0x1234" })).toThrow(
    "address must be 20 bytes of hex",
  );
  expect(() =>
    encodeResultMessage({ ...fromFixture(), consumer: signed.consumer.slice(2) }),
  ).toThrow("must start with 0x");
});
