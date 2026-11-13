import { MAX_CONTENT_BYTES, checkContent, contentHash } from "./content.ts";

/**
 * A client for the storage service (ADR 0003): Claims and Evidence are
 * uploaded under their sha256 and checked against it when read back.
 */
export interface StorageOptions {
  /** The storage service's base URL, e.g. `https://enzure-storage.example.workers.dev`. */
  storageUrl: string;
  fetch?: typeof globalThis.fetch;
}

/** Content read back from storage and checked against the hash it is filed under. */
export type FetchedContent =
  | { status: "match"; text: string }
  | { status: "mismatch"; text: string }
  | { status: "missing" }
  /** Over {@link MAX_CONTENT_BYTES}, as stored bytes or as a JSON string; `size` is in bytes. */
  | { status: "too_large"; size: number }
  /** The bytes match the hash but aren't UTF-8 text. */
  | { status: "not_utf8" };

const utf8 = new TextEncoder();

function contentUrl(storageUrl: string, hash: string): string {
  return `${storageUrl.replace(/\/$/, "")}/content/${hash}`;
}

/**
 * Uploads `text` as UTF-8 under its sha256 and returns the hash, the value to
 * put on-chain. Uploading content that is already stored succeeds. Throws with
 * the service's error code if it rejects the upload.
 */
export async function putContent(
  { storageUrl, fetch = globalThis.fetch }: StorageOptions,
  text: string,
): Promise<string> {
  const bytes = utf8.encode(text);
  const hash = await contentHash(bytes);
  const response = await fetch(contentUrl(storageUrl, hash), {
    method: "PUT",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: bytes,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(`Storage rejected the upload: ${body.error ?? `HTTP ${response.status}`}`);
  }
  return hash;
}

/**
 * Reads the content filed under `hash` and checks it with `checkContent`:
 * its bytes hash to `hash`, it is UTF-8 text and within the size cap.
 * Content that doesn't match is still returned, marked `mismatch`, so a
 * reader can see what was served. Content whose Content-Length is over the
 * cap is refused without reading it. Throws on any other HTTP error.
 */
export async function fetchContent(
  { storageUrl, fetch = globalThis.fetch }: StorageOptions,
  hash: string,
): Promise<FetchedContent> {
  const response = await fetch(contentUrl(storageUrl, hash));
  if (response.status === 404) return { status: "missing" };
  if (!response.ok) throw new Error(`storage: HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_CONTENT_BYTES) {
    await response.body?.cancel();
    return { status: "too_large", size: length };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const check = await checkContent(hash, bytes);
  if (check.ok) return { status: "match", text: new TextDecoder().decode(bytes) };
  switch (check.reason) {
    case "hash_mismatch":
      return { status: "mismatch", text: new TextDecoder().decode(bytes) };
    case "too_large":
      return { status: "too_large", size: check.size };
    case "not_utf8":
      return { status: "not_utf8" };
  }
}
