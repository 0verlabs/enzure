import { createPublicClient, createWalletClient, custom, parseTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { expect, test } from "vite-plus/test";
import {
  checkSignedResult,
  evmHooksToRelay,
  evmHooksToSign,
  relaySignedResult,
  type HookView,
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
const nearHook: HookView = {
  near: { consumer: "consumer.testnet", gas: "20000000000000", status: "failed" },
};
const assertion = (id: number, state: string, hooks: HookView[]) => ({
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
    assertion(3, "settled", [
      nearHook,
      evmHook("unsigned"),
      evmHook("signed"),
      evmHook("unsigned", 1),
    ]),
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
    assertion(2, "settled", [
      evmHook("signed"),
      evmHook("signed", 1),
      nearHook,
      evmHook("unsigned"),
    ]),
    assertion(1, "settled", [evmHook("signing"), evmHook("signed")]),
  ];

  expect(evmHooksToRelay(assertions, 84532)).toEqual([
    { assertionId: 2, hookIndex: 0, chainId: 84532, receiver, consumer },
    { assertionId: 1, hookIndex: 1, chainId: 84532, receiver, consumer },
  ]);
});

/**
 * `deliver` calldata for the fixture, from `cast calldata
 * "deliver((uint256,address,bool,bytes32,bytes32,uint256),uint8,bytes32,bytes32)" ...`,
 * the Receiver's Solidity signature.
 */
const FIXTURE_DELIVER_CALLDATA =
  "0x4c010a7e00000000000000000000000000000000000000000000000000000000000000010000000000000000000000002000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000164a5dddb88128a31ba9a3c719b73d55160a125423dff298529c354abb204dd2ad209d4ed1ac27c592d2d790dc3f9c7789e6f34debc22791573fa0f4597763d3c000000000000000000000000000000000000000000000000000000006af6f24b000000000000000000000000000000000000000000000000000000000000001b17c79b326cc96de7d9853e0aeb7f8a80d0e7b6f00e6329fce0be0027a68e3e374f28be9ce65cfb9df73d568a45c467318410f27c2167f172b8ad981fa3c8fc8c";
const IS_DELIVERED = "0xfb1d5610";
const ORACLE = "0x7dc0d1d0";
const TX_HASH = `0x${"ab".repeat(32)}`;
const word = (hex: string) => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;

/** A fake EVM node: answers the reads the Relayer makes and records raw transactions. */
function fakeChain(options: { chainId?: number; delivered?: boolean; oracle?: string } = {}) {
  const sent: `0x${string}`[] = [];
  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    const args = (params ?? []) as { data?: string; input?: string }[];
    switch (method) {
      case "eth_chainId":
        return `0x${(options.chainId ?? 84532).toString(16)}`;
      case "eth_call": {
        const data = args[0]?.data ?? args[0]?.input ?? "";
        if (data.startsWith(IS_DELIVERED)) return word(options.delivered ? "1" : "0");
        if (data.startsWith(ORACLE)) return word((options.oracle ?? fixture.address).slice(2));
        throw new Error(`unexpected eth_call ${data.slice(0, 10)}`);
      }
      case "eth_getTransactionCount":
        return "0x0";
      case "eth_estimateGas":
        return "0x61a80";
      case "eth_gasPrice":
      case "eth_maxPriorityFeePerGas":
        return "0x3b9aca00";
      case "eth_getBlockByNumber":
        return { number: "0x10", baseFeePerGas: "0x3b9aca00", hash: TX_HASH, timestamp: "0x0" };
      case "eth_sendRawTransaction":
        sent.push(args[0] as unknown as `0x${string}`);
        return TX_HASH;
      case "eth_blockNumber":
        return "0x11";
      case "eth_getTransactionReceipt":
        return {
          transactionHash: TX_HASH,
          blockHash: TX_HASH,
          blockNumber: "0x10",
          status: "0x1",
          logs: [],
          from: account.address,
          to: receiver,
          gasUsed: "0x0",
          cumulativeGasUsed: "0x0",
          effectiveGasPrice: "0x0",
          transactionIndex: "0x0",
          type: "0x2",
          logsBloom: `0x${"00".repeat(256)}`,
        };
      default:
        throw new Error(`unexpected RPC ${method}`);
    }
  };
  const transport = custom({ request });
  return {
    sent,
    publicClient: createPublicClient({ chain: baseSepolia, transport }),
    walletClient: createWalletClient({ account, chain: baseSepolia, transport }),
  };
}

// anvil's well-known first development key; not a secret.
const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

test("the Relayer delivers a signed result to its Receiver", async () => {
  const chain = fakeChain();

  const result = await relaySignedResult(chain, signed());

  expect(result).toEqual({ status: "delivered", transactionHash: TX_HASH });
  expect(chain.sent).toHaveLength(1);
  const tx = parseTransaction(chain.sent[0]!);
  expect(tx.to).toBe(receiver);
  expect(tx.chainId).toBe(84532);
  expect(tx.data).toBe(FIXTURE_DELIVER_CALLDATA);
});

test("the Relayer sends nothing for a result the Receiver already recorded", async () => {
  const chain = fakeChain({ delivered: true });

  expect(await relaySignedResult(chain, signed())).toEqual({ status: "already_delivered" });
  expect(chain.sent).toHaveLength(0);
});

test("the Relayer sends nothing for a result its Receiver would reject", async () => {
  const otherOracle = fakeChain({ oracle: "0x3000000000000000000000000000000000000003" });
  expect(await relaySignedResult(otherOracle, signed())).toEqual({
    status: "rejected",
    reason: "not signed by the oracle",
  });

  const otherChain = fakeChain({ chainId: 1 });
  expect(await relaySignedResult(otherChain, signed())).toEqual({
    status: "rejected",
    reason: "signed for chain 84532, not chain 1",
  });

  expect([...otherOracle.sent, ...otherChain.sent]).toHaveLength(0);
});
