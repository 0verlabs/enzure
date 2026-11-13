import { encodeAbiParameters } from "viem";
import { expect, test } from "vite-plus/test";
import { fetchEvmDelivery } from "../src/index.ts";

const RECEIVER = "0x1000000000000000000000000000000000000001";
const CONSUMER = "0x2000000000000000000000000000000000000002";
const DELIVERY_TX = "0x5d9c0e2b3bd1a0f3e8a7e7d0b6f1e6f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8";
/** keccak256("OutcomeRecorded(uint256,address,bool,bytes32,bytes32,uint256)"), from `cast keccak`. */
const OUTCOME_RECORDED = "0xd2979aca8754036f52fc224a158cf4292e47db0bb7d3a4ef0ef26fb937ba8038";
/** Selectors from `cast sig`. */
const IS_DELIVERED = "0xfb1d5610";
const OUTCOME_OF = "0xbb79ea6a";

const CLAIM_HASH = `0x${"aa".repeat(32)}` as const;
const ASSERTER = `0x${"bb".repeat(32)}` as const;

function fakeChain({ delivered, recorded }: { delivered: boolean; recorded: boolean }) {
  const rpcCalls: Array<{ to: string; data: string; block: string }> = [];
  const logQueries: URL[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(url instanceof Request ? url.url : url);
    if (target.origin === "https://logs.example") {
      logQueries.push(target);
      return Response.json(
        delivered
          ? { status: "1", message: "OK", result: [{ transactionHash: DELIVERY_TX }] }
          : { status: "0", message: "No logs found", result: [] },
      );
    }
    const { method, params, id } = JSON.parse(init!.body as string);
    expect(method).toBe("eth_call");
    rpcCalls.push({ ...params[0], block: params[1] });
    const data: string = params[0].data;
    const result = data.startsWith(IS_DELIVERED)
      ? encodeAbiParameters([{ type: "bool" }], [delivered])
      : data.startsWith(OUTCOME_OF)
        ? encodeAbiParameters(
            [
              { type: "bool" },
              { type: "bool" },
              { type: "bytes32" },
              { type: "bytes32" },
              { type: "uint256" },
            ],
            recorded
              ? [true, true, CLAIM_HASH, ASSERTER, 1794575790n]
              : [false, false, `0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`, 0n],
          )
        : "0x";
    return Response.json({ jsonrpc: "2.0", id, result });
  };
  return { fetch: fetch as typeof globalThis.fetch, rpcCalls, logQueries };
}

test("a delivered EVM Hook shows the Receiver's recorded outcome and the delivery transaction", async () => {
  const chain = fakeChain({ delivered: true, recorded: true });

  const delivery = await fetchEvmDelivery(
    { rpcUrl: "https://rpc.example", logsApiUrl: "https://logs.example/api", fetch: chain.fetch },
    { receiver: RECEIVER, consumer: CONSUMER, assertionId: 7 },
  );

  expect(delivery).toEqual({
    delivered: true,
    outcome: { recorded: true, truthful: true, claimHash: CLAIM_HASH, settledAt: "1794575790" },
    transactionHash: DELIVERY_TX,
  });
  expect(chain.rpcCalls.map((call) => call.to)).toEqual([RECEIVER, RECEIVER]);
  const query = chain.logQueries[0]!.searchParams;
  expect(query.get("module")).toBe("logs");
  expect(query.get("action")).toBe("getLogs");
  expect(query.get("address")).toBe(RECEIVER);
  expect(query.get("topic0")).toBe(OUTCOME_RECORDED);
  expect(query.get("topic1")).toBe(`0x${"0".repeat(63)}7`);
  expect(query.get("topic2")).toBe(`0x${"0".repeat(24)}${CONSUMER.slice(2)}`);
});

test("an EVM Hook the Receiver hasn't recorded is not delivered and has no delivery transaction", async () => {
  const chain = fakeChain({ delivered: false, recorded: false });

  const delivery = await fetchEvmDelivery(
    { rpcUrl: "https://rpc.example", logsApiUrl: "https://logs.example/api", fetch: chain.fetch },
    { receiver: RECEIVER, consumer: CONSUMER, assertionId: 7 },
  );

  expect(delivery).toMatchObject({
    delivered: false,
    outcome: { recorded: false },
    transactionHash: null,
  });
  expect(chain.logQueries).toEqual([]);
});

test("without a logs API the delivery is still read, with no transaction", async () => {
  const chain = fakeChain({ delivered: true, recorded: true });

  const delivery = await fetchEvmDelivery(
    { rpcUrl: "https://rpc.example", fetch: chain.fetch },
    { receiver: RECEIVER, consumer: CONSUMER, assertionId: 7 },
  );

  expect(delivery).toMatchObject({ delivered: true, transactionHash: null });
});
