import { expect, test } from "vite-plus/test";
import { checkAttestedSigner, type AttestationReport } from "../src/index.ts";
import { signedResponse as f } from "./fixture.ts";

const report = (): AttestationReport => ({ model_attestations: [{ ...f.attestation }] });
const expected = () => ({
  modelId: f.model_id,
  signingKey: f.public_key,
  nonce: f.attestation.nonce,
});

test("the real attestation binds the key that signed the real response to our nonce", () => {
  expect(checkAttestedSigner(report(), expected())).toEqual({
    matchingCandidates: 1,
    nonceEchoed: true,
    reportData: f.public_key + f.attestation.nonce,
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
  const twice = { model_attestations: [{ ...f.attestation }, { ...f.attestation }] };
  expect(checkAttestedSigner(twice, expected()).valid).toBe(false);
});

test("a report with no model attestations fails", () => {
  expect(checkAttestedSigner({}, expected()).valid).toBe(false);
});
