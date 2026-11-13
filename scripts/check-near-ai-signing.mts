// Checks that NEAR AI Cloud signs exactly what the oracle contract will check.
//
// Sends one AI Verdict request built by core (no streaming, aliasing off,
// structured output and a seed), fetches its ed25519 signature, checks it end
// to end, and checks the signing key against the model's attestation report.
//
//   node --env-file-if-exists=.env scripts/check-near-ai-signing.mts [--model <id>] [--write-fixture]
//
// Needs NEARAI_API_KEY in the environment. One request costs well under $0.001.
// --write-fixture saves the signed response to fixtures/near-ai-cloud/signed-response.json.

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  NEAR_AI_URL,
  PROMPT_TEMPLATE_V1,
  buildAiRequest,
  checkAttestedSigner,
  checkSignedResponse,
  parseVerdict,
  type AiRequestInput,
  type AttestationReport,
  type ResponseSignature,
} from "../typescript/packages/core/src/index.ts";

const SIGNATURE_TIMEOUT_MS = 30_000;
const FIXTURE = join(import.meta.dirname, "..", "fixtures", "near-ai-cloud", "signed-response.json");

const { values: args } = parseArgs({
  options: {
    model: { type: "string" },
    "write-fixture": { type: "boolean", default: false },
  },
});

const apiKey = process.env.NEARAI_API_KEY;
if (!apiKey) {
  console.error("error: set NEARAI_API_KEY (see .env.example)");
  process.exit(1);
}
const auth = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };

const template = { ...PROMPT_TEMPLATE_V1, modelId: args.model ?? PROMPT_TEMPLATE_V1.modelId };
const input: AiRequestInput = {
  claim: 'The text in the Asserter\'s Evidence has exactly three lines and contains the word "café".',
  asserterEvidence: "Morning at the café\nsteam rises from a small cup\nthe street wakes slowly",
  disputerEvidence: "The text has four lines, so the claim is false.",
  seed: randomBytes(4).readUInt32LE(),
};

// 1. Preflight: fetch the model's attestation with a fresh nonce.
const nonce = randomBytes(32).toString("hex");
const attestationUrl = new URL(`${NEAR_AI_URL}/attestation/report`);
attestationUrl.search = new URLSearchParams({
  model: template.modelId,
  provider: "near",
  signing_algo: "ed25519",
  include_tls_fingerprint: "false",
  nonce,
}).toString();
const attestationResponse = await fetch(attestationUrl, {
  headers: { ...auth, "x-no-aliasing": "true" },
});
if (!attestationResponse.ok) {
  fail(`attestation report: HTTP ${attestationResponse.status} ${await attestationResponse.text()}`);
}
const attestation = (await attestationResponse.json()) as AttestationReport;
const attestedKeys = (attestation.model_attestations ?? [])
  .filter((candidate) => candidate.signing_algo === "ed25519")
  .map((candidate) => candidate.signing_address);
if (attestedKeys.length !== 1) {
  fail(`expected one ed25519 model attestation for ${template.modelId}, got ${attestedKeys.length}`);
}
const [attestedKey] = attestedKeys as [string];

// 2. Send the request and keep the exact bytes both ways.
const requestBody = buildAiRequest(template, input);
const completion = await fetch(`${NEAR_AI_URL}/chat/completions`, {
  method: "POST",
  body: requestBody,
  headers: {
    ...auth,
    "Content-Type": "application/json",
    "Accept-Encoding": "identity",
    "x-no-aliasing": "true",
  },
});
const responseBody = new Uint8Array(await completion.arrayBuffer());
// Strict decoding, so the fixture's text is exactly these bytes.
const responseText = new TextDecoder("utf-8", { fatal: true }).decode(responseBody);
if (!completion.ok) fail(`chat completion: HTTP ${completion.status} ${responseText}`);
const completionJson = JSON.parse(responseText) as { id: string; usage?: unknown };
const chatId = completionJson.id;

// 3. Fetch the signature, retrying while it isn't recorded yet.
const signature = await fetchSignature(chatId);

// 4. Check everything.
const check = await checkSignedResponse({
  modelId: template.modelId,
  requestBody,
  responseBody,
  signature,
  publicKey: attestedKey,
});
const attested = checkAttestedSigner(attestation, {
  modelId: template.modelId,
  signingKey: signature.signing_address,
  nonce,
});
let verdict: string;
try {
  verdict = parseVerdict(responseBody);
} catch (error) {
  verdict = `does not parse (${(error as Error).message})`;
}
// Structured output and the seed count as working when the signed request carried both.
const sent = JSON.parse(new TextDecoder().decode(requestBody)) as {
  seed?: number;
  response_format?: { type?: string };
};
const structuredAndSeedSigned =
  check.valid && sent.response_format?.type === "json_schema" && sent.seed === input.seed;

const rows: [string, unknown][] = [
  ["model id", template.modelId],
  ["chat id", chatId],
  ["seed", input.seed],
  ["signature kind", signature.signature_kind ?? "(missing)"],
  ["signing algo", signature.signing_algo],
  ["request hash", check.requestHash],
  ["response hash", check.responseHash],
  ["signed text matches", check.textMatches],
  ["signer is attested key", check.signerMatches],
  ["signature verifies", check.signatureValid],
  ["attestation candidates", attested.matchingCandidates],
  ["attestation echoes nonce", attested.nonceEchoed],
  ["quote binds key + nonce", attested.reportDataBindsKey],
  ["structured output + seed", structuredAndSeedSigned ? "signed as provider_tee" : "NOT signed"],
  ["verdict", verdict],
  ["response bytes", responseBody.length],
  ["usage", JSON.stringify(completionJson.usage)],
];
for (const [label, value] of rows) console.log(`${label.padEnd(26)} ${value}`);

const ok = structuredAndSeedSigned && attested.valid && !verdict.startsWith("does not parse");
console.log(
  ok
    ? "\nOK: provider_tee ed25519 signature over the exact bytes, from the attested key, with structured output and a seed."
    : "\nFAILED: see the checks above.",
);
if (!structuredAndSeedSigned) {
  console.log(
    "Structured output or the seed may break signing. The fallback (a plain one-word answer, parsed strictly) is not built yet; see issue #2.",
  );
}
if (!ok) process.exit(1);

if (args["write-fixture"]) {
  const [candidate] = (attestation.model_attestations ?? []).filter(
    (entry) =>
      entry.model_name === template.modelId && entry.signing_address === signature.signing_address,
  );
  const fixture = {
    description:
      "A real NEAR AI Cloud AI Verdict response, signed inside the model TEE. Written by scripts/check-near-ai-signing.mts.",
    captured_at: new Date().toISOString(),
    prompt_template: {
      version: template.version,
      model_id: template.modelId,
      system_prompt: template.systemPrompt,
      temperature: template.temperature,
      max_tokens: template.maxTokens,
      enable_thinking: template.enableThinking,
    },
    input: {
      claim: input.claim,
      asserter_evidence: input.asserterEvidence,
      disputer_evidence: input.disputerEvidence,
      seed: input.seed,
    },
    model_id: template.modelId,
    chat_id: chatId,
    request_body: new TextDecoder().decode(requestBody),
    response_body: responseText,
    request_hash: check.requestHash,
    response_hash: check.responseHash,
    signed_text: signature.text,
    signature: signature.signature,
    public_key: signature.signing_address,
    signing_algo: signature.signing_algo,
    signature_kind: signature.signature_kind,
    verdict,
    attestation: {
      nonce,
      model_name: candidate?.model_name,
      signing_address: candidate?.signing_address,
      signing_algo: candidate?.signing_algo,
      request_nonce: candidate?.request_nonce,
      intel_quote: candidate?.intel_quote,
    },
  };
  await mkdir(dirname(FIXTURE), { recursive: true });
  await writeFile(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${FIXTURE}`);
}

async function fetchSignature(id: string): Promise<ResponseSignature> {
  const url = `${NEAR_AI_URL}/signature/${encodeURIComponent(id)}?signing_algo=ed25519`;
  const deadline = Date.now() + SIGNATURE_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    const response = await fetch(url, { headers: auth });
    const text = await response.text();
    last = `HTTP ${response.status} ${text}`;
    // A 404, or a 2xx carrying error_code, means it isn't recorded yet.
    if (response.ok) {
      const body = JSON.parse(text) as Record<string, unknown>;
      if (!("error_code" in body)) return body as unknown as ResponseSignature;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail(`no signature for ${id} within ${SIGNATURE_TIMEOUT_MS / 1000} s: ${last}`);
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}
