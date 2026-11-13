import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The real signed NEAR AI Cloud response in the root fixtures folder. */
export const signedResponse = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../../fixtures/near-ai-cloud/signed-response.json"),
    "utf8",
  ),
) as {
  prompt_template: {
    version: number;
    model_id: string;
    system_prompt: string;
    temperature: number;
    max_tokens: number;
    enable_thinking: boolean;
  };
  input: { claim: string; asserter_evidence: string; disputer_evidence: string; seed: number };
  model_id: string;
  request_body: string;
  response_body: string;
  request_hash: string;
  response_hash: string;
  signed_text: string;
  signature: string;
  public_key: string;
  signing_algo: string;
  signature_kind: string;
  verdict: string;
  attestation: {
    nonce: string;
    model_name: string;
    signing_address: string;
    signing_algo: string;
    request_nonce: string;
    intel_quote: string;
  };
};

export const bytes = (text: string) => new TextEncoder().encode(text);
