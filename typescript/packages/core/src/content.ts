/**
 * Rules for Claim and Evidence content, which is stored off-chain and
 * committed on-chain by its sha256 hash (ADR 0003).
 */

/** NEAR's maximum transaction size: 1.5 MiB. */
export const NEAR_MAX_TRANSACTION_BYTES = 1_572_864;

/**
 * Room left in the `submit_ai_verdict` transaction for the model response,
 * the signature, the JSON escaping of the content and the transaction
 * envelope.
 */
export const RESPONSE_AND_OVERHEAD_BYTES = 196_608;

/**
 * The largest Claim or Evidence item that can be stored: 448 KiB.
 *
 * A Claim and both Evidence items (three items) plus the model response
 * must fit in one NEAR transaction.
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
  | { ok: false; reason: "too_large"; size: number; maxSize: number }
  | { ok: false; reason: "hash_mismatch"; expected: string; actual: string };

/**
 * Checks that `bytes` may be stored under `hash`: it is within the size cap
 * and its sha256 is exactly `hash`.
 */
export async function checkContent(
  hash: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<ContentCheck> {
  if (bytes.byteLength > MAX_CONTENT_BYTES) {
    return { ok: false, reason: "too_large", size: bytes.byteLength, maxSize: MAX_CONTENT_BYTES };
  }
  const actual = await contentHash(bytes);
  if (actual !== hash) {
    return { ok: false, reason: "hash_mismatch", expected: hash, actual };
  }
  return { ok: true };
}
