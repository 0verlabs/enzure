// The off-chain attestation check a DAO member runs before proposing a
// Registered Key (spec story 77).
//
// Fetches the model's attestation report from NEAR AI Cloud with a fresh nonce
// and checks that exactly one ed25519 model attestation names the model, that it
// echoes the nonce, and that its TDX quote's report data binds the signing key
// to that nonce. Prints the checks to standard error and the attested key (64
// hex characters, no 0x) to standard output, so
// `key=$(node scripts/near-ai-attested-key.mts)` works.
//
//   node --env-file-if-exists=.env scripts/near-ai-attested-key.mts [--model <id>]
//
// Needs NEARAI_API_KEY. It does not check Intel's signature over the quote or
// the measured software; scripts/check-near-ai-signing.mts additionally checks a
// real signed response end to end.

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import {
  PROMPT_TEMPLATE_V1,
  checkAttestedSigner,
  type AttestationReport,
} from "../typescript/packages/core/src/index.ts";

const API = "https://cloud-api.near.ai/v1";

const { values: args } = parseArgs({ options: { model: { type: "string" } } });
const modelId = args.model ?? PROMPT_TEMPLATE_V1.modelId;
const apiKey = process.env.NEARAI_API_KEY;
if (!apiKey) fail("set NEARAI_API_KEY (see .env.example)");

const nonce = randomBytes(32).toString("hex");
const url = new URL(`${API}/attestation/report`);
url.search = new URLSearchParams({
  model: modelId,
  provider: "near",
  signing_algo: "ed25519",
  include_tls_fingerprint: "false",
  nonce,
}).toString();
const response = await fetch(url, {
  headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "x-no-aliasing": "true" },
});
if (!response.ok) fail(`attestation report: HTTP ${response.status} ${await response.text()}`);
const report = (await response.json()) as AttestationReport;
const keys = [
  ...new Set(
    (report.model_attestations ?? [])
      .filter((entry) => entry.signing_algo === "ed25519" && entry.model_name === modelId)
      .map((entry) => entry.signing_address.replace(/^0x/, "").toLowerCase()),
  ),
];
if (keys.length !== 1) fail(`expected one ed25519 attestation for ${modelId}, got ${keys.length}`);
const [key] = keys as [string];
const check = checkAttestedSigner(report, { modelId, signingKey: key, nonce });

const rows: [string, unknown][] = [
  ["model id", modelId],
  ["nonce sent", nonce],
  ["attested ed25519 key", key],
  ["attestation candidates", check.matchingCandidates],
  ["attestation echoes nonce", check.nonceEchoed],
  ["quote report data", check.reportData ?? "(unreadable)"],
  ["quote binds key + nonce", check.reportDataBindsKey],
];
for (const [label, value] of rows) console.error(`${label.padEnd(26)} ${value}`);
if (!check.valid) fail("the attestation check failed; do not register this key");
console.error("OK: the key is bound to a fresh TDX quote for this model.");
console.log(key);

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}
