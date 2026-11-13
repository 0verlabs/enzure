import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

const BASE = "https://storage.test";

const encoder = new TextEncoder();

// sha256("Alice delivered the logo described in the brief.")
const CLAIM = encoder.encode("Alice delivered the logo described in the brief.");
const CLAIM_HASH = "92a68687cda219c63223154d2855c33635f7bd32dbbd67942b8484334ceca6a0";

// sha256 of zero bytes
const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// A fresh client address per upload, so these tests never reach the upload rate limit.
let client = 0;

function upload(hash: string, body: BodyInit): Promise<Response> {
  return exports.default.fetch(`${BASE}/content/${hash}`, {
    method: "PUT",
    body,
    headers: { "CF-Connecting-IP": `2001:db8::${(++client).toString(16)}` },
  });
}

function download(hash: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/content/${hash}`);
}

describe("storing content under its sha256 hash", () => {
  it("stores content uploaded under its hash and serves the exact bytes back", async () => {
    const put = await upload(CLAIM_HASH, CLAIM);
    expect(put.status).toBe(201);

    const get = await download(CLAIM_HASH);
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(CLAIM);
  });

  it("rejects content whose bytes don't match the hash and stores nothing", async () => {
    const put = await upload(EMPTY_HASH, encoder.encode("Alice did not deliver the logo."));
    expect(put.status).toBe(422);
    expect(await put.json()).toMatchObject({ error: "hash_mismatch" });

    expect((await download(EMPTY_HASH)).status).toBe(404);
  });

  it("accepts the same content again without changing it", async () => {
    const evidence = encoder.encode("The logo file is attached at https://example.com/logo.svg.");
    const hash = "8452a9b18f2dd4fcb6356ed251da17448668f75e89b80395ae8fb6c8df437d2c";

    expect((await upload(hash, evidence)).status).toBe(201);
    const again = await upload(hash, evidence);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ hash, size: evidence.byteLength });

    const get = await download(hash);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(evidence);
  });

  it("rejects a path that isn't a lowercase hex sha256", async () => {
    for (const hash of ["abc", CLAIM_HASH.toUpperCase(), `${CLAIM_HASH}0`]) {
      const put = await upload(hash, CLAIM);
      expect(put.status).toBe(400);
      expect(await put.json()).toMatchObject({ error: "invalid_hash" });
      expect((await download(hash)).status).toBe(400);
    }
  });
});

describe("the size cap", () => {
  // 448 KiB: three items plus the model response fit in a 1.5 MiB NEAR transaction.
  const CAP = 458_752;

  it("stores content of exactly the cap", async () => {
    const atCap = new Uint8Array(CAP).fill(0x61);
    const hash = "c5c5704602144ec2937cf0b4eb59e4cbf0265b5788c6aea03e03044ef4b52f0b";

    expect((await upload(hash, atCap)).status).toBe(201);
  });

  it("rejects content above the cap and stores nothing", async () => {
    const overCap = new Uint8Array(CAP + 1).fill(0x61);
    const hash = "ccceb1a1d0f49daa1f4811d3f1fd7da37c63748d29f03b7a4370c31115b388be";

    const put = await upload(hash, overCap);
    expect(put.status).toBe(413);
    expect(await put.json()).toMatchObject({ error: "too_large", maxSize: CAP });

    expect((await download(hash)).status).toBe(404);
  });

  it("rejects a streamed upload that grows above the cap", async () => {
    // sha256 of the 512 KiB this stream sends
    const hash = "85a84a75886e8a526dbec4e16e3375faa307b4aead79c9ed3264c0477a6f6eba";
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > CAP) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });

    const put = await upload(hash, body);
    expect(put.status).toBe(413);
  });

  it("counts the size content takes as a JSON string in the transaction", async () => {
    // Each newline becomes two bytes ("\n") in the transaction's JSON arguments.
    const newlines = new Uint8Array(CAP / 2 + 1).fill(0x0a);
    const hash = "dbd98d722cdb1e452a97cfafb07f5ec8215c1bfea8f2a8ced93a06590a8720c2";

    const put = await upload(hash, newlines);
    expect(put.status).toBe(413);
    expect(await put.json()).toMatchObject({ error: "too_large", maxSize: CAP });

    expect((await download(hash)).status).toBe(404);
  });
});

describe("text content", () => {
  it("rejects bytes that aren't UTF-8 text and stores nothing", async () => {
    const notText = new Uint8Array([0xff, 0xfe]);
    const hash = "b3d510ef04275ca8e698e5b3cbb0ece3949ef9252f0cdc839e9ee347409a2209";

    const put = await upload(hash, notText);
    expect(put.status).toBe(422);
    expect(await put.json()).toMatchObject({ error: "not_utf8" });

    expect((await download(hash)).status).toBe(404);
  });
});
