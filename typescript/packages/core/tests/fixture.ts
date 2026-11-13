import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AiRequestInput, PromptTemplate } from "../src/index.ts";

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

/** The fixture's Prompt Template, in core's shape. */
export function templateFromFixture(): PromptTemplate {
  const template = signedResponse.prompt_template;
  return {
    version: template.version,
    modelId: template.model_id,
    systemPrompt: template.system_prompt,
    temperature: template.temperature,
    maxTokens: template.max_tokens,
    enableThinking: template.enable_thinking,
  };
}

/** The fixture's Claim, Evidence and seed, in core's shape. */
export function inputFromFixture(): AiRequestInput {
  const { input } = signedResponse;
  return {
    claim: input.claim,
    asserterEvidence: input.asserter_evidence,
    disputerEvidence: input.disputer_evidence,
    seed: input.seed,
  };
}
