# Example NEAR Consumer

A NEAR contract that learns Assertion outcomes from the Enzure oracle through a NEAR Hook. It accepts `assertion_resolved` only from the oracle it was initialised with and records each Assertion's outcome once, ignoring repeats.

Post an Assertion naming it as a Hook, with the gas the call should get (at most the oracle's `max_near_hook_gas`):

```json
"hooks": [{ "near": { "consumer": "<consumer account>", "gas": "20000000000000" } }]
```

Attach the bond plus `assertion_storage_deposit({ "hooks": 1 })`. When the Assertion settles, the oracle calls `assertion_resolved(assertion_id, truthful)`. If the call fails, anyone can call the oracle's `retry_near_hook(assertion_id, hook_index)`.

```bash
cargo near build non-reproducible-wasm   # build
# deploy, then initialise with: new({ "oracle": "<oracle account>" })
```

The oracle's sandbox tests (`contracts/near/oracle/tests/near_hooks.rs`) build and exercise this contract.
