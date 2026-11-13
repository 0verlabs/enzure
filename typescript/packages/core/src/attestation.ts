import { bytesToHex, hexToBytes } from "./signature.ts";

/** One entry of `model_attestations[]` in a NEAR AI Cloud attestation report. */
export interface ModelAttestation {
  model_name?: string;
  signing_address: string;
  signing_algo: string;
  request_nonce: string;
  /** Hex-encoded Intel TDX quote. */
  intel_quote: string;
}

export interface AttestationReport {
  model_attestations?: ModelAttestation[];
}

export interface AttestedSignerCheck {
  /** Candidates for the model that use ed25519 and the given signing key. */
  matchingCandidates: number;
  /** True when the matching candidate echoes the nonce we sent. */
  nonceEchoed: boolean;
  /** The quote's 64-byte report data, as hex, or undefined if it couldn't be read. */
  reportData: string | undefined;
  /** True when report data is the signing key followed by the nonce. */
  reportDataBindsKey: boolean;
  /** True when exactly one candidate matches and every check above passes. */
  valid: boolean;
}

/**
 * Checks that a model attestation report names `signingKey` as the model's
 * ed25519 signer and that the TDX quote's report data binds that key to our
 * nonce (`report_data = key || nonce` for NEAR-operated models requested
 * without a TLS fingerprint).
 *
 * This reads the quote without verifying it. Verifying the quote's
 * signature, TCB status, MRCONFIGID and RTMR3 (for example with dcap-qvl),
 * and the GPU evidence with NVIDIA NRAS, is part of registering a key, not
 * of this check.
 */
export function checkAttestedSigner(
  report: AttestationReport,
  expected: { modelId: string; signingKey: string; nonce: string },
): AttestedSignerCheck {
  const key = hexToBytes(expected.signingKey, 32);
  const nonce = hexToBytes(expected.nonce, 32);
  const candidates = (report.model_attestations ?? []).filter(
    (candidate) =>
      (candidate.model_name === undefined || candidate.model_name === expected.modelId) &&
      candidate.signing_algo === "ed25519" &&
      key !== undefined &&
      bytesToHex(hexToBytes(candidate.signing_address, 32) ?? new Uint8Array()) === bytesToHex(key),
  );

  const [candidate] = candidates;
  const nonceEchoed =
    candidate !== undefined &&
    nonce !== undefined &&
    candidate.request_nonce.toLowerCase() === bytesToHex(nonce);
  const reportData = candidate === undefined ? undefined : tdxReportData(candidate.intel_quote);
  const reportDataBindsKey =
    reportData !== undefined &&
    key !== undefined &&
    nonce !== undefined &&
    reportData === bytesToHex(key) + bytesToHex(nonce);

  return {
    matchingCandidates: candidates.length,
    nonceEchoed,
    reportData,
    reportDataBindsKey,
    valid: candidates.length === 1 && nonceEchoed && reportDataBindsKey,
  };
}

const TDX_TEE_TYPE = 0x81;
const QUOTE_HEADER_LENGTH = 48;
/** Offset of REPORTDATA inside the TD report body. */
const REPORT_DATA_OFFSET = 520;

/** Reads the 64-byte report data from a TDX quote, version 4 or 5. */
function tdxReportData(quoteHex: string): string | undefined {
  const digits = quoteHex.startsWith("0x") ? quoteHex.slice(2) : quoteHex;
  if (digits.length % 2 !== 0) return undefined;
  const quote = hexToBytes(digits, digits.length / 2);
  if (quote === undefined || quote.length < QUOTE_HEADER_LENGTH) return undefined;

  const view = new DataView(quote.buffer, quote.byteOffset, quote.byteLength);
  const version = view.getUint16(0, true);
  if (view.getUint32(4, true) !== TDX_TEE_TYPE) return undefined;

  // Version 5 puts a 2-byte body type and a 4-byte body size before the body.
  const bodyOffset =
    version === 4 ? QUOTE_HEADER_LENGTH : version === 5 ? QUOTE_HEADER_LENGTH + 6 : -1;
  const start = bodyOffset + REPORT_DATA_OFFSET;
  if (bodyOffset < 0 || quote.length < start + 64) return undefined;
  return bytesToHex(quote.subarray(start, start + 64));
}
