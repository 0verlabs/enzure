import { expect, test } from "vite-plus/test";
import {
  MAX_CONTENT_BYTES,
  createResolver,
  prepareAiVerdict,
  sha256Hex,
  type OracleAssertion,
  type OracleCall,
  type OracleView,
  type ResolverOptions,
} from "../src/index.ts";
import { bytes, signedResponse as fixture } from "./fixture.ts";

const STORAGE = "https://storage.example";
const NEAR_AI = "https://cloud-api.example/v1";
const {
  claim,
  asserter_evidence: asserterEvidence,
  disputer_evidence: disputerEvidence,
} = fixture.input;

async function disputedAssertion(id = 1, { withEvidence = true } = {}): Promise<OracleAssertion> {
  return {
    id,
    asserter: "alice.testnet",
    claim_hash: await sha256Hex(bytes(claim)),
    evidence_hash: withEvidence ? await sha256Hex(bytes(asserterEvidence)) : null,
    bond: "1000000000000000000000000",
    state: "disputed",
    asserted_at_ns: "1794568700000000000",
    liveness_ends_at_ns: "1794568760000000000",
    settled_at_ns: null,
    outcome: null,
    hooks: [],
    prompt_template_version: 1,
    dispute: {
      disputer: "bob.testnet",
      evidence_hash: withEvidence ? await sha256Hex(bytes(disputerEvidence)) : null,
      seed: fixture.input.seed,
      disputed_at_ns: "1794568710000000000",
      ai_verdict_deadline_ns: "1794572310000000000",
    },
    ai_verdicts: [],
    appeal_window_ends_at_ns: null,
    appeal: null,
  };
}

/** A fake oracle: answers the views the Resolver reads and records `ai_request` arguments. */
function fakeOracle(registeredKey = fixture.public_key) {
  const aiRequests: Record<string, unknown>[] = [];
  const view: OracleView = async <T>(method: string, args: Record<string, unknown>) => {
    switch (method) {
      case "get_prompt_template":
        expect(args).toEqual({ version: 1 });
        return { ...fixture.prompt_template, version: 1 } as T;
      case "get_registered_keys":
        return [{ public_key: registeredKey, model_id: fixture.model_id }] as T;
      case "ai_request":
        aiRequests.push(args);
        return fixture.request_body as T;
      default:
        throw new Error(`unexpected view ${method}`);
    }
  };
  return { view, aiRequests };
}

interface FakeServices {
  /** Content by hash; missing hashes get a 404. */
  content?: Record<string, Uint8Array | Response>;
  /** How many signature reads answer 404 before the signature is there. */
  signatureMisses?: number;
  /** Never record the signature. */
  noSignature?: boolean;
}

/** Fake storage and NEAR AI Cloud at the HTTP boundary, recording every request. */
async function fakeServices({
  content,
  signatureMisses = 1,
  noSignature = false,
}: FakeServices = {}) {
  const store = content ?? {
    [await sha256Hex(bytes(claim))]: bytes(claim),
    [await sha256Hex(bytes(asserterEvidence))]: bytes(asserterEvidence),
    [await sha256Hex(bytes(disputerEvidence))]: bytes(disputerEvidence),
  };
  const requests: { url: string; method: string; headers: Headers; body?: Uint8Array }[] = [];
  let misses = signatureMisses;
  const fetch = async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    const body =
      init?.body === undefined
        ? undefined
        : new Uint8Array(await new Response(init.body).arrayBuffer());
    requests.push({ url, method, headers: new Headers(init?.headers), body });
    if (url.startsWith(`${STORAGE}/content/`)) {
      const stored = store[url.slice(`${STORAGE}/content/`.length)];
      if (stored instanceof Response) return stored;
      return stored ? new Response(stored) : Response.json({ error: "not_found" }, { status: 404 });
    }
    if (url === `${NEAR_AI}/chat/completions` && method === "POST") {
      return new Response(fixture.response_body, {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith(`${NEAR_AI}/signature/${fixture.chat_id}`)) {
      if (noSignature || misses-- > 0)
        return Response.json({ detail: "not found" }, { status: 404 });
      return Response.json({
        text: fixture.signed_text,
        signature: `0x${fixture.signature}`,
        signing_address: `0x${fixture.public_key}`,
        signing_algo: "ed25519",
        signature_kind: "provider_tee",
      });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

function options(
  view: OracleView,
  fetch: typeof globalThis.fetch,
  overrides: Partial<ResolverOptions> = {},
): ResolverOptions {
  return {
    view,
    fetch,
    storageUrl: STORAGE,
    nearAiUrl: NEAR_AI,
    nearAiApiKey: "test-key",
    signatureRetryMs: 1,
    signatureTimeoutMs: 200,
    ...overrides,
  };
}

const expectedArgs = {
  assertion_id: 1,
  claim,
  asserter_evidence: asserterEvidence,
  disputer_evidence: disputerEvidence,
  response_body: fixture.response_body,
  signed_text: fixture.signed_text,
  signature: fixture.signature,
  public_key: fixture.public_key,
};

test("the Resolver turns a disputed Assertion into submit_ai_verdict arguments the real fixture signs", async () => {
  const oracle = fakeOracle();
  const services = await fakeServices();

  const result = await prepareAiVerdict(
    options(oracle.view, services.fetch),
    await disputedAssertion(),
  );

  expect(result).toEqual({ status: "ready", verdict: "TRUE", args: expectedArgs });
  expect(oracle.aiRequests).toEqual([
    {
      assertion_id: 1,
      claim,
      asserter_evidence: asserterEvidence,
      disputer_evidence: disputerEvidence,
    },
  ]);
  const completion = services.requests.find((request) => request.method === "POST")!;
  expect(new TextDecoder().decode(completion.body)).toBe(fixture.request_body);
  expect(completion.headers.get("x-no-aliasing")).toBe("true");
  expect(completion.headers.get("authorization")).toBe("Bearer test-key");
  expect(JSON.parse(fixture.request_body).stream).toBe(false);
});

const nearAiCalls = (requests: { url: string }[]) =>
  requests.filter((request) => request.url.startsWith(NEAR_AI)).length;

test("content whose hash doesn't match is refused and NEAR AI is never asked", async () => {
  const oracle = fakeOracle();
  const claimHash = await sha256Hex(bytes(claim));
  const services = await fakeServices({ content: { [claimHash]: bytes(`${claim} (edited)`) } });

  const result = await prepareAiVerdict(
    options(oracle.view, services.fetch),
    await disputedAssertion(),
  );

  expect(result).toMatchObject({ status: "skipped" });
  expect(result.status === "skipped" && result.reason).toContain(
    `Claim from storage does not match ${claimHash}`,
  );
  expect(nearAiCalls(services.requests)).toBe(0);
  expect(oracle.aiRequests).toEqual([]);
});

test("missing content leaves the Assertion for the AI Verdict deadline", async () => {
  const oracle = fakeOracle();
  const services = await fakeServices({ content: {} });

  const result = await prepareAiVerdict(
    options(oracle.view, services.fetch),
    await disputedAssertion(),
  );

  expect(result).toEqual({
    status: "skipped",
    reason: `Claim ${await sha256Hex(bytes(claim))} is not in storage`,
  });
  expect(nearAiCalls(services.requests)).toBe(0);
});

test("oversized content is refused from its Content-Length without reading it", async () => {
  const oracle = fakeOracle();
  const claimHash = await sha256Hex(bytes(claim));
  const huge = new Response(bytes(claim), {
    headers: { "content-length": String(MAX_CONTENT_BYTES + 1) },
  });
  const services = await fakeServices({ content: { [claimHash]: huge } });

  const result = await prepareAiVerdict(
    options(oracle.view, services.fetch),
    await disputedAssertion(),
  );

  expect(result).toEqual({
    status: "skipped",
    reason: `Claim ${claimHash} is too large (${MAX_CONTENT_BYTES + 1} bytes)`,
  });
  expect(nearAiCalls(services.requests)).toBe(0);
});

test("an Assertion and dispute without Evidence send null for both, without downloading any", async () => {
  const oracle = fakeOracle();
  const services = await fakeServices();

  await prepareAiVerdict(
    options(oracle.view, services.fetch),
    await disputedAssertion(1, { withEvidence: false }),
  );

  expect(oracle.aiRequests).toEqual([
    { assertion_id: 1, claim, asserter_evidence: null, disputer_evidence: null },
  ]);
  expect(services.requests.filter((request) => request.url.startsWith(STORAGE))).toHaveLength(1);
});

test("the signature is read again until it is recorded", async () => {
  const oracle = fakeOracle();
  const services = await fakeServices({ signatureMisses: 3 });

  const result = await prepareAiVerdict(
    options(oracle.view, services.fetch),
    await disputedAssertion(),
  );

  expect(result.status).toBe("ready");
  const signatureReads = services.requests.filter((request) => request.url.includes("/signature/"));
  expect(signatureReads).toHaveLength(4);
  expect(signatureReads[0]!.url).toBe(
    `${NEAR_AI}/signature/${fixture.chat_id}?model=${encodeURIComponent(fixture.model_id)}&signing_algo=ed25519`,
  );
});

test("a signature that never arrives fails after the retry time instead of hanging", async () => {
  const oracle = fakeOracle();
  const services = await fakeServices({ noSignature: true });
  const started = Date.now();

  const result = await prepareAiVerdict(
    options(oracle.view, services.fetch, { signatureTimeoutMs: 50, signatureRetryMs: 10 }),
    await disputedAssertion(),
  );

  expect(result.status).toBe("failed");
  expect(result.status === "failed" && result.error).toContain(
    `no signature for chat ${fixture.chat_id} within 50 ms`,
  );
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("a response signed by a key that isn't Registered is not submitted", async () => {
  const oracle = fakeOracle("ab".repeat(32));
  const services = await fakeServices();

  const result = await prepareAiVerdict(
    options(oracle.view, services.fetch),
    await disputedAssertion(),
  );

  expect(result).toEqual({
    status: "skipped",
    reason: `${fixture.public_key} is not a Registered Key for ${fixture.model_id}`,
  });
});

test("a storage outage is a failure to retry, not a skip", async () => {
  const oracle = fakeOracle();
  const claimHash = await sha256Hex(bytes(claim));
  const services = await fakeServices({
    content: { [claimHash]: new Response("upstream down", { status: 503 }) },
  });

  const result = await prepareAiVerdict(
    options(oracle.view, services.fetch),
    await disputedAssertion(),
  );

  expect(result).toEqual({
    status: "failed",
    error: `storage: HTTP 503 for Claim ${claimHash}`,
  });
});

function recordingCall(fail = false) {
  const calls: { method: string; args: Record<string, unknown>; gas: string; deposit: string }[] =
    [];
  const call: OracleCall = async (method, args, { gas, deposit }) => {
    calls.push({ method, args, gas, deposit });
    if (fail) throw new Error("Smart contract panicked: This response is already recorded");
    return "TRUE";
  };
  return { call, calls };
}

test("each disputed Assertion gets one AI Verdict submitted, with 300 TGas and no deposit", async () => {
  const oracle = fakeOracle();
  const services = await fakeServices();
  const submit = recordingCall();
  const resolver = createResolver({ ...options(oracle.view, services.fetch), call: submit.call });
  const assertion = await disputedAssertion();
  const settled: OracleAssertion = { ...(await disputedAssertion(2)), state: "settled" };

  const first = await resolver.pass([settled, assertion]);
  // The view may still show it disputed until the transaction lands.
  const second = await resolver.pass([assertion]);

  expect(first).toEqual([{ assertionId: 1, status: "submitted", verdict: "TRUE" }]);
  expect(second).toEqual([]);
  expect(submit.calls).toEqual([
    {
      method: "submit_ai_verdict",
      args: expectedArgs,
      gas: "300000000000000",
      deposit: "0",
    },
  ]);
});

test("a skipped Assertion is not tried again", async () => {
  const oracle = fakeOracle();
  const services = await fakeServices({ content: {} });
  const submit = recordingCall();
  const resolver = createResolver({ ...options(oracle.view, services.fetch), call: submit.call });
  const assertion = await disputedAssertion();

  const first = await resolver.pass([assertion]);
  const second = await resolver.pass([assertion]);

  expect(first).toMatchObject([{ assertionId: 1, status: "skipped" }]);
  expect(second).toEqual([]);
  expect(services.requests).toHaveLength(1);
  expect(submit.calls).toEqual([]);
});

test("a failing Assertion is retried on later passes up to the attempt limit", async () => {
  const oracle = fakeOracle();
  const services = await fakeServices();
  const submit = recordingCall(true);
  const resolver = createResolver(
    { ...options(oracle.view, services.fetch), call: submit.call },
    { maxAttempts: 2 },
  );
  const assertion = await disputedAssertion();

  const passes = [];
  for (let i = 0; i < 3; i++) passes.push(await resolver.pass([assertion]));

  expect(passes.map((results) => results.map((result) => result.status))).toEqual([
    ["failed"],
    ["failed"],
    [],
  ]);
  expect(passes[0]![0]).toMatchObject({
    error: "Smart contract panicked: This response is already recorded",
  });
  expect(submit.calls).toHaveLength(2);
});

test("Assertions that already have an AI Verdict are left alone", async () => {
  const oracle = fakeOracle();
  const services = await fakeServices();
  const submit = recordingCall();
  const resolver = createResolver({ ...options(oracle.view, services.fetch), call: submit.call });
  const ruled: OracleAssertion = {
    ...(await disputedAssertion()),
    state: "ruled",
    ai_verdicts: [
      {
        verdict: "TRUE",
        request_hash: fixture.request_hash,
        response_hash: fixture.response_hash,
        public_key: fixture.public_key,
        accepted_at_ns: "1794568720000000000",
      },
    ],
  };

  expect(await resolver.pass([ruled])).toEqual([]);
  expect(services.requests).toEqual([]);
});
