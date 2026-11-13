/**
 * Rules for Claim and Evidence content, which is stored off-chain and
 * committed on-chain by its sha256 hash (ADR 0003).
 *
 * Content is UTF-8 text. Its bytes go on-chain only as JSON string arguments
 * of the `submit_ai_verdict` transaction, together with the model response.
 */

/** NEAR's maximum transaction size: 1.5 MiB. */
const NEAR_MAX_TRANSACTION_BYTES = 1_572_864;

/**
 * Room left in the `submit_ai_verdict` transaction for the model response,
 * the signature, the other arguments and the transaction envelope: 192 KiB.
 */
const RESPONSE_AND_OVERHEAD_BYTES = 196_608;

/**
 * The largest Claim or Evidence item, measured as UTF-8 bytes of its JSON
 * string without the quotes: 448 KiB.
 *
 * A Claim and both Evidence items (three items) plus the model response
 * must fit in one NEAR transaction. Measuring the JSON string counts the
 * escaping (a newline takes two bytes as `\n`), so three items at the cap
 * still fit.
 */
export const MAX_CONTENT_BYTES = Math.floor(
  (NEAR_MAX_TRANSACTION_BYTES - RESPONSE_AND_OVERHEAD_BYTES) / 3,
);

const CONTENT_HASH = /^[0-9a-f]{64}$/;

/** A content hash: the sha256 of the content as 64 lowercase hex characters. */
export function isContentHash(value: string): boolean {
  return CONTENT_HASH.test(value);
}

/** The content hash of `bytes`. */
export async function contentHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type ContentCheck =
  | { ok: true }
  | { ok: false; reason: "hash_mismatch"; expected: string; actual: string }
  | { ok: false; reason: "not_utf8" }
  | { ok: false; reason: "too_large"; size: number; maxSize: number };

const utf8 = new TextEncoder();

/**
 * Checks that `bytes` may be stored under `hash`: its sha256 is exactly
 * `hash`, it is UTF-8 text, and as a JSON string it is within the size cap.
 */
export async function checkContent(
  hash: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<ContentCheck> {
  // Escaping only adds bytes, so content over the cap can't fit as JSON.
  if (bytes.byteLength > MAX_CONTENT_BYTES) {
    return { ok: false, reason: "too_large", size: bytes.byteLength, maxSize: MAX_CONTENT_BYTES };
  }
  const actual = await contentHash(bytes);
  if (actual !== hash) {
    return { ok: false, reason: "hash_mismatch", expected: hash, actual };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "not_utf8" };
  }
  const size = utf8.encode(JSON.stringify(text)).byteLength - 2;
  if (size > MAX_CONTENT_BYTES) {
    return { ok: false, reason: "too_large", size, maxSize: MAX_CONTENT_BYTES };
  }
  return { ok: true };
}
