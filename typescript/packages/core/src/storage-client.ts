import { contentHash } from "./content.ts";

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
  | { status: "missing" };

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
 * Reads the content filed under `hash` and checks that its bytes hash to it.
 * Content that doesn't match is still returned, marked `mismatch`, so a
 * reader can see what was served.
 */
export async function fetchContent(
  { storageUrl, fetch = globalThis.fetch }: StorageOptions,
  hash: string,
): Promise<FetchedContent> {
  const response = await fetch(contentUrl(storageUrl, hash));
  if (response.status === 404) return { status: "missing" };
  if (!response.ok) throw new Error(`Storage: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  return (await contentHash(bytes)) === hash
    ? { status: "match", text }
    : { status: "mismatch", text };
}
