import { expect, test } from "vite-plus/test";
import {
  NEAR_AI_URL,
  attestedSigningKey,
  checkAttestedSigner,
  fetchAttestationReport,
  type AttestationReport,
} from "../src/index.ts";
import { signedResponse as fixture } from "./fixture.ts";

const report = (): AttestationReport => ({ model_attestations: [{ ...fixture.attestation }] });
const expected = () => ({
  modelId: fixture.model_id,
  signingKey: fixture.public_key,
  nonce: fixture.attestation.nonce,
});

test("the real attestation binds the key that signed the real response to our nonce", () => {
  expect(checkAttestedSigner(report(), expected())).toEqual({
    matchingCandidates: 1,
    nonceEchoed: true,
    reportData: fixture.public_key + fixture.attestation.nonce,
    reportDataBindsKey: true,
    valid: true,
  });
});

test("a different nonce fails", () => {
  const check = checkAttestedSigner(report(), { ...expected(), nonce: "00".repeat(32) });
  expect(check.nonceEchoed).toBe(false);
  expect(check.reportDataBindsKey).toBe(false);
  expect(check.valid).toBe(false);
});

test("a key the report doesn't name fails", () => {
  const check = checkAttestedSigner(report(), { ...expected(), signingKey: "11".repeat(32) });
  expect(check.matchingCandidates).toBe(0);
  expect(check.valid).toBe(false);
});

test("a report for another model fails", () => {
  const check = checkAttestedSigner(report(), { ...expected(), modelId: "z-ai/glm-5.3-flash" });
  expect(check.valid).toBe(false);
});

test("a candidate whose quote binds another key fails", () => {
  const forged = report();
  forged.model_attestations![0]!.signing_address = "11".repeat(32);
  const check = checkAttestedSigner(forged, { ...expected(), signingKey: "11".repeat(32) });
  expect(check.matchingCandidates).toBe(1);
  expect(check.reportDataBindsKey).toBe(false);
  expect(check.valid).toBe(false);
});

test("two candidates with the same key are ambiguous and fail", () => {
  const twice = { model_attestations: [{ ...fixture.attestation }, { ...fixture.attestation }] };
  expect(checkAttestedSigner(twice, expected()).valid).toBe(false);
});

test("a report with no model attestations fails", () => {
  expect(checkAttestedSigner({}, expected()).valid).toBe(false);
});

test("attestedSigningKey finds the report's one ed25519 key for the model and checks it against our nonce", () => {
  const { modelId, nonce } = expected();
  expect(attestedSigningKey(report(), { modelId, nonce })).toEqual({
    ok: true,
    key: fixture.public_key,
    check: checkAttestedSigner(report(), expected()),
  });
});

test("attestedSigningKey reads a 0x-prefixed, upper-case key", () => {
  const prefixed = report();
  prefixed.model_attestations![0]!.signing_address = `0x${fixture.public_key.toUpperCase()}`;
  const found = attestedSigningKey(prefixed, expected());
  expect(found.ok && found.key).toBe(fixture.public_key);
});

test("attestedSigningKey fails a key whose quote doesn't bind our nonce", () => {
  const found = attestedSigningKey(report(), { ...expected(), nonce: "00".repeat(32) });
  expect(found.ok).toBe(false);
  expect(!found.ok && found.check?.nonceEchoed).toBe(false);
});

test("attestedSigningKey fails with no ed25519 key for the model, or with two different ones", () => {
  const none = attestedSigningKey(report(), { ...expected(), modelId: "z-ai/glm-5.3-flash" });
  expect(none).toEqual({
    ok: false,
    error: "expected one ed25519 attestation for z-ai/glm-5.3-flash, got 0",
  });
  const other = { ...fixture.attestation, signing_address: "11".repeat(32) };
  const two = attestedSigningKey(
    { model_attestations: [{ ...fixture.attestation }, other] },
    expected(),
  );
  expect(two).toEqual({
    ok: false,
    error: `expected one ed25519 attestation for ${fixture.model_id}, got 2`,
  });
});

test("fetchAttestationReport asks NEAR AI Cloud for the model's ed25519 attestation with our nonce, without aliasing", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
    return Response.json(report());
  }) as typeof fetch;

  const fetched = await fetchAttestationReport({
    apiKey: "sk-test",
    modelId: "Qwen/Qwen3.8-27B",
    nonce: "ab".repeat(32),
    fetch: fakeFetch,
  });

  expect(fetched).toEqual(report());
  expect(calls).toEqual([
    {
      url: `${NEAR_AI_URL}/attestation/report?model=Qwen%2FQwen3.8-27B&provider=near&signing_algo=ed25519&include_tls_fingerprint=false&nonce=${"ab".repeat(32)}`,
      headers: {
        Authorization: "Bearer sk-test",
        Accept: "application/json",
        "x-no-aliasing": "true",
      },
    },
  ]);
});

test("fetchAttestationReport throws on an HTTP error, naming the status", async () => {
  const fakeFetch = (async () => new Response("no such model", { status: 404 })) as typeof fetch;
  await expect(
    fetchAttestationReport({ apiKey: "k", modelId: "m", nonce: "ab".repeat(32), fetch: fakeFetch }),
  ).rejects.toThrow("attestation report: HTTP 404 no such model");
});
