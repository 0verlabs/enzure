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

## `chain-signatures/signed-result.json`

A real EVM Hook signing from NEAR testnet: the oracle deployed to a development account posted an Assertion with one EVM Hook, settled it and called `sign_hook`, and `v1.signer-prod.testnet` signed the result message. Written by `scripts/oracle-evm-hook.sh --write-fixture`. It holds no private key.

| Field | Contents |
|---|---|
| `oracle`, `signer`, `path`, `domain_id` | The oracle account, the Chain Signatures signer, the derivation path and the secp256k1 domain it signed under. |
| `public_key`, `address` | The signer's `derived_public_key` for the oracle (`secp256k1:` and base58 of 64 bytes) and its EVM address, keccak256 of those 64 bytes, last 20. |
| `claim` | The Claim text; `signed_result.claim_hash` is its sha256. |
| `sign_hook_transaction` | The `sign_hook` transaction hash on testnet. |
| `signer_response` | The signer's raw answer: `big_r` (compressed point, hex), `s` (hex) and `recovery_id`. |
| `signed_result` | What `get_signed_result` returned: the fields of the result message, the 288-byte `message`, its keccak256 `digest`, and `r`, `s`, `v` (`v = recovery_id + 27`). |

Rust, TypeScript and Solidity encodings of the result message must give `message` and `digest` from the fields, and `ecrecover(digest, v, r, s)` must give `address`. The Receiver and Consumer addresses are placeholders with no code on any chain; Foundry tests can place contracts there with `deployCodeTo`.
