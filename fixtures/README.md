# Fixtures

Real signed artefacts shared by the Rust, Solidity and TypeScript tests (ADR 0005). Each fixture is real data captured from a live service, not hand-made.

## `near-ai-cloud/signed-response.json`

A real AI Verdict from NEAR AI Cloud, signed inside the model TEE, written by `scripts/check-near-ai-signing.mts --write-fixture`. It holds no API key or other secret.

| Field | Contents |
|---|---|
| `prompt_template` | The Prompt Template the request was built from (version, model id, system prompt, inference settings). |
| `input` | The Claim, both Evidence items and the seed. |
| `request_body`, `response_body` | The exact bytes sent and received, as UTF-8 strings. |
| `request_hash`, `response_hash` | SHA-256 of those bytes, as hex. |
| `signed_text` | `model_id:request_hash:response_hash`. |
| `signature`, `public_key` | The ed25519 signature over `signed_text` and the model's signing key, as hex without `0x`. |
| `model_id`, `signing_algo`, `signature_kind`, `chat_id`, `verdict` | As returned (`provider_tee`, `ed25519`). |
| `attestation` | The nonce we sent and the model's attestation entry (signing key, echoed nonce, TDX quote), so tests can check that the quote binds the signing key. |

A contract or library that builds the request from `prompt_template` and `input` must produce bytes whose SHA-256 is `request_hash`.
