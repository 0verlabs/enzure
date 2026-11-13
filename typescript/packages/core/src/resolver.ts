import { checkContent, MAX_CONTENT_BYTES } from "./content.ts";
import type { Verdict } from "./ai-request.ts";
import type { OracleView } from "./relayer.ts";
import type { OracleAssertion } from "./scheduler.ts";
import { checkSignedResponse, type ResponseSignature } from "./signature.ts";
import { parseVerdict } from "./verdict.ts";

/** NEAR AI Cloud's OpenAI-compatible API. */
export const NEAR_AI_URL = "https://cloud-api.near.ai/v1";

/** Gas for `submit_ai_verdict`: a 60 KB content test needs this much. */
export const SUBMIT_AI_VERDICT_GAS = "300000000000000";

export interface ResolverOptions {
  view: OracleView;
  /** The storage service's base URL; content is read from `GET {storageUrl}/content/{hash}`. */
  storageUrl: string;
  nearAiApiKey: string;
  /** Defaults to {@link NEAR_AI_URL}. */
  nearAiUrl?: string;
  /** How long to keep asking for the response signature. Defaults to 30 s. */
  signatureTimeoutMs?: number;
  /** The pause between signature reads. Defaults to 1 s. */
  signatureRetryMs?: number;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** The arguments of the oracle's `submit_ai_verdict`. */
export interface SubmitAiVerdictArgs {
  assertion_id: number;
  claim: string;
  asserter_evidence: string | null;
  disputer_evidence: string | null;
  response_body: string;
  signed_text: string;
  /** ed25519 signature, 128 hex characters, no `0x`. */
  signature: string;
  /** ed25519 public key, 64 hex characters, no `0x`. */
  public_key: string;
}

/**
 * What the Resolver made of a disputed Assertion.
 *
 * - `ready`: a signed AI Verdict to submit.
 * - `skipped`: it can't get a valid AI Verdict (content missing, oversized
 *   or not matching its hash, or a signer that isn't a Registered Key). It
 *   leaves the Assertion for the AI Verdict deadline to send to Appeal.
 * - `failed`: something that may work on a later try (a service was down).
 */
export type ResolveResult =
  | { status: "ready"; verdict: Verdict; args: SubmitAiVerdictArgs }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

class Skip extends Error {}

/**
 * Gets a signed AI Verdict for a disputed Assertion: downloads the Claim and
 * both Evidence items from storage and checks their hashes, asks the oracle's
 * `ai_request` view for the exact request bytes, sends them unchanged to NEAR
 * AI Cloud (no streaming, aliasing disabled), fetches the ed25519 signature
 * with a bounded retry, and checks it against the oracle's Registered Keys
 * before anything is paid for on-chain.
 */
export async function prepareAiVerdict(
  options: ResolverOptions,
  assertion: OracleAssertion,
): Promise<ResolveResult> {
  try {
    return await prepare(options, assertion);
  } catch (error) {
    if (error instanceof Skip) return { status: "skipped", reason: error.message };
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

async function prepare(
  options: ResolverOptions,
  assertion: OracleAssertion,
): Promise<ResolveResult> {
  const { view } = options;
  const fetch = options.fetch ?? globalThis.fetch;
  const nearAiUrl = options.nearAiUrl ?? NEAR_AI_URL;
  if (assertion.state !== "disputed" || assertion.dispute === null) {
    throw new Skip(`Assertion ${assertion.id} is ${assertion.state}, not disputed`);
  }
  if (assertion.prompt_template_version === null) {
    throw new Skip(`Assertion ${assertion.id} has no Prompt Template`);
  }
  const template = await view<{ model_id: string } | null>("get_prompt_template", {
    version: assertion.prompt_template_version,
  });
  if (template === null) {
    throw new Skip(`Prompt Template ${assertion.prompt_template_version} not found`);
  }
  const modelId = template.model_id;

  const content = {
    claim: await download(options, fetch, "Claim", assertion.claim_hash),
    asserter_evidence: await downloadOptional(
      options,
      fetch,
      "Asserter's Evidence",
      assertion.evidence_hash,
    ),
    disputer_evidence: await downloadOptional(
      options,
      fetch,
      "Disputer's Evidence",
      assertion.dispute.evidence_hash,
    ),
  };

  const request = await view<string>("ai_request", { assertion_id: assertion.id, ...content });
  const requestBody = new TextEncoder().encode(request);
  const auth = { Authorization: `Bearer ${options.nearAiApiKey}` };
  const completion = await fetch(`${nearAiUrl}/chat/completions`, {
    method: "POST",
    body: requestBody,
    headers: {
      ...auth,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Accept-Encoding": "identity",
      "x-no-aliasing": "true",
    },
  });
  const responseBody = new Uint8Array(await completion.arrayBuffer());
  const responseText = new TextDecoder("utf-8", { fatal: true }).decode(responseBody);
  if (!completion.ok) {
    throw new Error(`NEAR AI chat completion: HTTP ${completion.status} ${responseText}`);
  }
  const verdict = parseVerdict(responseBody);
  const { id: chatId } = JSON.parse(responseText) as { id: string };

  const signature = await fetchSignature(options, fetch, nearAiUrl, chatId, modelId);
  const publicKey = strip0x(signature.signing_address).toLowerCase();
  const registered = await view<{ public_key: string; model_id: string }[]>(
    "get_registered_keys",
    {},
  );
  if (!registered.some((key) => key.public_key === publicKey && key.model_id === modelId)) {
    throw new Skip(`${publicKey} is not a Registered Key for ${modelId}`);
  }
  const check = await checkSignedResponse({
    modelId,
    requestBody,
    responseBody,
    signature,
    publicKey,
  });
  if (!(check.textMatches && check.signerMatches && check.signatureValid)) {
    throw new Error(`NEAR AI signature does not check out: ${JSON.stringify(check)}`);
  }

  return {
    status: "ready",
    verdict,
    args: {
      assertion_id: assertion.id,
      ...content,
      response_body: responseText,
      signed_text: signature.text,
      signature: strip0x(signature.signature),
      public_key: publicKey,
    },
  };
}

async function downloadOptional(
  options: ResolverOptions,
  fetch: typeof globalThis.fetch,
  name: string,
  hash: string | null,
): Promise<string | null> {
  return hash === null ? null : download(options, fetch, name, hash);
}

/** Reads content from storage and refuses it unless it is UTF-8 within the size cap and matches `hash`. */
async function download(
  { storageUrl }: ResolverOptions,
  fetch: typeof globalThis.fetch,
  name: string,
  hash: string,
): Promise<string> {
  const response = await fetch(`${storageUrl.replace(/\/$/, "")}/content/${hash}`);
  if (response.status === 404) throw new Skip(`${name} ${hash} is not in storage`);
  if (!response.ok) throw new Error(`storage: HTTP ${response.status} for ${name} ${hash}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_CONTENT_BYTES) {
    await response.body?.cancel();
    throw new Skip(`${name} ${hash} is too large (${length} bytes)`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const check = await checkContent(hash, bytes);
  if (!check.ok) {
    throw new Skip(
      check.reason === "hash_mismatch"
        ? `${name} from storage does not match ${hash} (got ${check.actual})`
        : check.reason === "too_large"
          ? `${name} ${hash} is too large (${check.size} bytes)`
          : `${name} ${hash} is not UTF-8`,
    );
  }
  return new TextDecoder().decode(bytes);
}

/** Reads a chat's ed25519 signature, retrying while NEAR AI Cloud hasn't recorded it yet. */
async function fetchSignature(
  options: ResolverOptions,
  fetch: typeof globalThis.fetch,
  nearAiUrl: string,
  chatId: string,
  modelId: string,
): Promise<ResponseSignature> {
  const timeoutMs = options.signatureTimeoutMs ?? 30_000;
  const retryMs = options.signatureRetryMs ?? 1_000;
  const url = new URL(`${nearAiUrl}/signature/${encodeURIComponent(chatId)}`);
  url.search = new URLSearchParams({ model: modelId, signing_algo: "ed25519" }).toString();
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${options.nearAiApiKey}`, Accept: "application/json" },
    });
    const text = await response.text();
    last = `HTTP ${response.status} ${text}`;
    // A 404, or a 2xx carrying error_code, means it isn't recorded yet.
    if (response.ok) {
      const body = JSON.parse(text) as Record<string, unknown>;
      if (!("error_code" in body)) return body as unknown as ResponseSignature;
    }
    if (Date.now() + retryMs > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  throw new Error(`no signature for chat ${chatId} within ${timeoutMs} ms: ${last}`);
}

function strip0x(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

/**
 * Calls a change method of the oracle with JSON arguments, gas and a deposit
 * in yoctoNEAR, and returns its parsed result; for example near-kit's
 * `near.call(oracle, method, args, { gas, attachedDeposit })`.
 */
export type OracleCall = (
  method: string,
  args: Record<string, unknown>,
  options: { gas: string; deposit: string },
) => Promise<unknown>;

export type ResolverPassResult =
  | { assertionId: number; status: "submitted"; verdict: Verdict }
  | { assertionId: number; status: "skipped"; reason: string }
  | { assertionId: number; status: "failed"; error: string };

/**
 * A Resolver that remembers what it has done, so each disputed Assertion is
 * handled once: after a submitted or skipped AI Verdict it is never tried
 * again, and after failures it is retried on later passes up to
 * `maxAttempts` times (default 3). Memory lasts as long as the process; on a
 * restart, Assertions the oracle still shows as disputed are tried again.
 */
export function createResolver(
  options: ResolverOptions & { call: OracleCall },
  { maxAttempts = 3 }: { maxAttempts?: number } = {},
) {
  const done = new Set<number>();
  const attempts = new Map<number, number>();
  return {
    /** Handles every disputed Assertion without an AI Verdict that isn't done yet, one at a time. */
    async pass(assertions: readonly OracleAssertion[]): Promise<ResolverPassResult[]> {
      const results: ResolverPassResult[] = [];
      for (const assertion of assertions) {
        if (
          assertion.state !== "disputed" ||
          assertion.ai_verdicts.length > 0 ||
          done.has(assertion.id)
        ) {
          continue;
        }
        const tries = (attempts.get(assertion.id) ?? 0) + 1;
        attempts.set(assertion.id, tries);
        const result = await resolve(options, assertion);
        if (result.status !== "failed" || tries >= maxAttempts) done.add(assertion.id);
        results.push(result);
      }
      return results;
    },
  };
}

async function resolve(
  options: ResolverOptions & { call: OracleCall },
  assertion: OracleAssertion,
): Promise<ResolverPassResult> {
  const assertionId = assertion.id;
  const prepared = await prepareAiVerdict(options, assertion);
  if (prepared.status === "skipped") return { assertionId, ...prepared };
  if (prepared.status === "failed") return { assertionId, ...prepared };
  try {
    await options.call(
      "submit_ai_verdict",
      { ...prepared.args },
      {
        gas: SUBMIT_AI_VERDICT_GAS,
        deposit: "0",
      },
    );
  } catch (error) {
    return {
      assertionId,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { assertionId, status: "submitted", verdict: prepared.verdict };
}
