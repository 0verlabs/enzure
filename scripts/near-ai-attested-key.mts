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
// Needs NEARAI_API_KEY; NEAR_AI_URL overrides core's NEAR AI Cloud URL. The
// selection and checks are core's `attestedSigningKey`. It does not check
// Intel's signature over the quote or the measured software;
// scripts/check-near-ai-signing.mts additionally checks a real signed response
// end to end.

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import {
  PROMPT_TEMPLATE_V1,
  attestedSigningKey,
  fetchAttestationReport,
} from "../typescript/packages/core/src/index.ts";

const { values: args } = parseArgs({ options: { model: { type: "string" } } });
const modelId = args.model ?? PROMPT_TEMPLATE_V1.modelId;
const apiKey = process.env.NEARAI_API_KEY;
if (!apiKey) fail("set NEARAI_API_KEY (see .env.example)");

const nonce = randomBytes(32).toString("hex");
const report = await fetchAttestationReport({
  apiKey,
  modelId,
  nonce,
  ...(process.env.NEAR_AI_URL ? { nearAiUrl: process.env.NEAR_AI_URL } : {}),
}).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
const found = attestedSigningKey(report, { modelId, nonce });
if (!found.check) fail(found.ok ? "no attestation check" : found.error);
const check = found.check;

const rows: [string, unknown][] = [
  ["model id", modelId],
  ["nonce sent", nonce],
  ["attested ed25519 key", found.ok ? found.key : "(failed)"],
  ["attestation candidates", check.matchingCandidates],
  ["attestation echoes nonce", check.nonceEchoed],
  ["quote report data", check.reportData ?? "(unreadable)"],
  ["quote binds key + nonce", check.reportDataBindsKey],
];
for (const [label, value] of rows) console.error(`${label.padEnd(26)} ${value}`);
if (!found.ok) fail(`${found.error}; do not register this key`);
console.error("OK: the key is bound to a fresh TDX quote for this model.");
console.log(found.key);

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}
