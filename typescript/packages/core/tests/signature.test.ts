import { expect, test } from "vite-plus/test";
import { checkSignedResponse, type SignedResponse } from "../src/index.ts";
import { bytes, signedResponse as f } from "./fixture.ts";

const fromFixture = (): SignedResponse => ({
  modelId: f.model_id,
  requestBody: bytes(f.request_body),
  responseBody: bytes(f.response_body),
  signature: {
    text: f.signed_text,
    signature: f.signature,
    signing_address: f.public_key,
    signing_algo: f.signing_algo,
    signature_kind: f.signature_kind,
  },
  publicKey: f.public_key,
});

test("the real signed response passes every check", async () => {
  const check = await checkSignedResponse(fromFixture());

  expect(check).toEqual({
    requestHash: f.request_hash,
    responseHash: f.response_hash,
    expectedText: f.signed_text,
    providerTee: true,
    textMatches: true,
    signerMatches: true,
    signatureValid: true,
    valid: true,
  });
});

test("a 0x prefix on the signature and key is accepted", async () => {
  const response = fromFixture();
  response.signature.signature = `0x${f.signature}`;
  response.publicKey = `0x${f.public_key}`;

  expect((await checkSignedResponse(response)).valid).toBe(true);
});

test("one changed request byte fails the signed-text check", async () => {
  const response = fromFixture();
  response.requestBody = bytes(f.request_body.replace('"seed":', '"seed": '));

  const check = await checkSignedResponse(response);
  expect(check.textMatches).toBe(false);
  expect(check.valid).toBe(false);
});

test("one changed response byte fails the signed-text check", async () => {
  const response = fromFixture();
  response.responseBody = bytes(f.response_body.replace("TRUE", "FALS"));

  const check = await checkSignedResponse(response);
  expect(check.textMatches).toBe(false);
  expect(check.valid).toBe(false);
});

test("a different model id fails the signed-text check", async () => {
  const response = fromFixture();
  response.modelId = "z-ai/glm-5.3-flash";

  expect((await checkSignedResponse(response)).valid).toBe(false);
});

test("a signature text altered to match tampered bytes doesn't verify", async () => {
  const response = fromFixture();
  response.responseBody = bytes(f.response_body.replace("TRUE", "FALS"));
  const { expectedText } = await checkSignedResponse(response);
  response.signature.text = expectedText;

  const check = await checkSignedResponse(response);
  expect(check.textMatches).toBe(true);
  expect(check.signatureValid).toBe(false);
  expect(check.valid).toBe(false);
});

test("a key other than the signer's fails", async () => {
  const response = fromFixture();
  // The ed25519 key the NEAR AI gateway attested for z-ai/glm-5.3-flash.
  response.publicKey = "5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff";

  const check = await checkSignedResponse(response);
  expect(check.signerMatches).toBe(false);
  expect(check.signatureValid).toBe(false);
  expect(check.valid).toBe(false);
});

test("one flipped signature bit fails", async () => {
  const response = fromFixture();
  const last = Number.parseInt(f.signature.slice(-1), 16) ^ 1;
  response.signature.signature = f.signature.slice(0, -1) + last.toString(16);

  const check = await checkSignedResponse(response);
  expect(check.signatureValid).toBe(false);
  expect(check.valid).toBe(false);
});

test("a gateway signature is not accepted", async () => {
  const response = fromFixture();
  response.signature.signature_kind = "gateway";

  const check = await checkSignedResponse(response);
  expect(check.providerTee).toBe(false);
  expect(check.valid).toBe(false);
});

test.each(["", "zz", "00".repeat(63)])("a malformed signature %j fails", async (signature) => {
  const response = fromFixture();
  response.signature.signature = signature;

  expect((await checkSignedResponse(response)).signatureValid).toBe(false);
});
