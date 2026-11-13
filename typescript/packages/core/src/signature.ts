/** The body of `GET /v1/signature/{chat_id}` on NEAR AI Cloud. */
export interface ResponseSignature {
  text: string;
  /** Hex, with or without a `0x` prefix. */
  signature: string;
  /** For ed25519, the hex public key. */
  signing_address: string;
  signing_algo: string;
  signature_kind?: string;
}

export interface SignedResponse {
  /** The canonical model id the request was sent with. */
  modelId: string;
  /** The exact bytes sent. */
  requestBody: Uint8Array;
  /** The exact bytes received. */
  responseBody: Uint8Array;
  signature: ResponseSignature;
  /** The ed25519 key the caller trusts for this model, as hex. */
  publicKey: string;
}

export interface SignatureCheck {
  requestHash: string;
  responseHash: string;
  /** `model_id:sha256(request):sha256(response)`. */
  expectedText: string;
  /** True when the kind is `provider_tee` and the algorithm is ed25519. */
  providerTee: boolean;
  /** True when the signed text equals `expectedText`. */
  textMatches: boolean;
  /** True when the signature names the trusted key as its signer. */
  signerMatches: boolean;
  /** True when the ed25519 signature over the signed text verifies against the trusted key. */
  signatureValid: boolean;
  /** True when every check above passes. */
  valid: boolean;
}

/**
 * Checks a NEAR AI Cloud response signature end to end, as the oracle
 * contract does: both hashes are computed over the exact bytes, the signed
 * text must name the pinned model, and the ed25519 signature must verify
 * against the trusted key. Malformed hex makes the check fail instead of
 * throwing.
 */
export async function checkSignedResponse(response: SignedResponse): Promise<SignatureCheck> {
  const { modelId, signature: sig } = response;
  const requestHash = await sha256Hex(response.requestBody);
  const responseHash = await sha256Hex(response.responseBody);
  const expectedText = `${modelId}:${requestHash}:${responseHash}`;

  const providerTee = sig.signature_kind === "provider_tee" && sig.signing_algo === "ed25519";
  const textMatches = sig.text === expectedText;
  const publicKey = hexToBytes(response.publicKey, 32);
  const signerMatches =
    publicKey !== undefined && equalBytes(hexToBytes(sig.signing_address, 32), publicKey);
  const signatureValid =
    publicKey !== undefined && (await verifyEd25519(publicKey, sig.signature, sig.text));

  return {
    requestHash,
    responseHash,
    expectedText,
    providerTee,
    textMatches,
    signerMatches,
    signatureValid,
    valid: providerTee && textMatches && signerMatches && signatureValid,
  };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return bytesToHex(new Uint8Array(digest));
}

async function verifyEd25519(publicKey: Uint8Array, signatureHex: string, text: string) {
  const signature = hexToBytes(signatureHex, 64);
  if (signature === undefined) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      new Uint8Array(signature),
      new TextEncoder().encode(text),
    );
  } catch {
    // The key bytes aren't a valid ed25519 point.
    return false;
  }
}

/** Decodes hex with an optional `0x` prefix, or returns undefined if it isn't `length` bytes of hex. */
export function hexToBytes(hex: string, length: number): Uint8Array | undefined {
  const digits = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (digits.length !== length * 2 || !/^[0-9a-fA-F]*$/.test(digits)) return undefined;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  return a !== undefined && a.length === b.length && a.every((byte, i) => byte === b[i]);
}
