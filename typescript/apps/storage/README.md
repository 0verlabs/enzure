# @enzure/storage

The storage service for Claims and Evidence (ADR 0003): a Hono Worker on Cloudflare, backed by the R2 bucket `enzure-content`. Content is filed under its sha256 hash, so only the hash goes on-chain. Anyone can upload, and nobody can swap content, because an upload whose bytes don't match its hash is rejected.

Deployed at **https://enzure-storage.luckzivanius.workers.dev**.

## API

Hashes are sha256 as 64 lowercase hex characters.

| Request                                              | Response                                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PUT /content/{hash}` with the raw bytes as the body | `201 {hash, size}` when stored; `200 {hash, size}` when the same content is already stored, which changes nothing |
| `GET /content/{hash}`                                | `200` with the exact bytes as `application/octet-stream`; `404` if nothing is stored                              |

Rejections, with a JSON `error` field:

- `400 invalid_hash`: the path isn't a lowercase hex sha256.
- `413 too_large`: the content is over 448 KiB (458,752 bytes), measured as its JSON string, because that is how it travels in the `submit_ai_verdict` transaction. Escaping counts, so a newline takes two bytes. The cap leaves room for a Claim, both Evidence items and the model response in one 1.5 MiB NEAR transaction.
- `422 hash_mismatch`: the body's sha256 isn't the hash in the path. Nothing is stored.
- `422 not_utf8`: the body isn't UTF-8 text. Claims and Evidence are text. Nothing is stored.
- `429 rate_limited`: more than 30 uploads in a minute from one IP. Downloads aren't limited, because stored content never changes and can be cached.

The hash, text and size rules live in `@enzure/core`.

CORS allows the origins in `ALLOWED_ORIGINS` in `cloudflare.config.ts`: the web app's local dev servers and `https://enzure-web.luckzivanius.workers.dev`. If the web app (ticket #13) deploys under another name, update that list and redeploy.

## Develop

Run from `typescript/` unless noted:

```bash
vp install                       # also generates .cloudflare/types with cf workers types
vp test                          # HTTP tests in the Workers runtime (local R2 and rate limiter)
cd apps/storage && vp exec cf dev   # local server with local R2
```

## Deploy

```bash
./scripts/deploy-storage.sh      # from the repository root
```

The script reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment or the root `.env`, which is not committed. The token needs Workers Scripts and R2 edit permissions. Without a token, `cf` uses a `cf auth login` session. The first deploy creates the R2 bucket.

Upload and download from the command line with `scripts/storage-upload.sh` and `scripts/storage-download.sh`.
