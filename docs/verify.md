# Check it without keys


These need only a shell with `curl` and `jq`; the `near` commands need [near-cli-rs](https://github.com/near/near-cli-rs) 0.31 and the `cast` commands need [Foundry](https://github.com/foundry-rs/foundry). Nothing here signs a transaction. Each was run on 2026-11-13.

**1. Read the oracle's config.** It shows the DAO and the demo timers (seconds):

```bash
near contract call-function as-read-only oracle-1794575543.enzure-council-a-1794575224.testnet \
  get_config json-args '{}' network-config testnet now
```

You see `"dao": "enzure-1794575224.sputnikv2.testnet"`, `"default_liveness": 120`, `"appeal_window": 60`, `"ai_verdict_deadline": 60`, `"dao_deadline": 600`, `"min_bond": "1000000000000000000000000"` (1 NEAR).

**2. Check that nobody holds a full-access key to the oracle.**

```bash
./scripts/oracle-lockdown.sh oracle-1794575543.enzure-council-a-1794575224.testnet --verify-only
```

You see `OK: oracle-1794575543.enzure-council-a-1794575224.testnet has no full-access keys. Only its DAO can change its code, through upgrade.` `near account list-keys oracle-1794575543.enzure-council-a-1794575224.testnet network-config testnet now` shows an empty key table.

**3. Read the paid run's Assertion** (Assertion 3, from the escrow demo), without the near CLI:

```bash
curl -s https://rpc.testnet.near.org -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"oracle-1794575543.enzure-council-a-1794575224.testnet","method_name":"get_assertion","args_base64":"eyJhc3NlcnRpb25faWQiOjN9"}}' \
  | jq '.result.result | implode | fromjson | {state, outcome, claim_hash, evidence_hash, disputer: .dispute.disputer, verdicts: [.ai_verdicts[].verdict], hooks}'
```

(`eyJhc3NlcnRpb25faWQiOjN9` is base64 of `{"assertion_id":3}`.) You see `"state": "settled"`, `"outcome": true`, `"verdicts": ["TRUE"]`, the Claim hash `6737fd60…8caa` and one EVM Hook with `"status": "signed"`. With `"args_base64":"eyJhc3NlcnRpb25faWQiOjV9"` (Assertion 5, the refunded run) you see `"outcome": false` and `["FALSE"]`. Assertion 1 (`eyJhc3NlcnRpb25faWQiOjF9`) went to the DAO: its `appeal.reason` is `"no_verdict"` and its `outcome` is `true`.

**4. Read the Claim and Evidence and check their hashes.**

```bash
curl -s https://enzure-storage.luckzivanius.workers.dev/content/6737fd606296d5e1ea3ac20f470896757bf8fcd0b84b81da863b54db62178caa | tee /dev/stderr | shasum -a 256
./scripts/storage-download.sh 48557b6df9e88a074c9ee5268b839c214475173db4f1b367588265321da5c387    # the seller's poem
./scripts/storage-download.sh b86abc87fddaf53c8c9cdd917f62978c3d5f62810261f5b7c6dc3396dcb36ad1    # the buyer's Evidence
```

The first prints the Claim (escrow job 4, the brief "Write a short poem about a lighthouse at night. It must have exactly three lines and use the word "beam".") and the same hash as `claim_hash`. `storage-download.sh` prints the content and `verified <hash>`; it writes nothing if the bytes don't match.

**5. Check the Chain Signatures signature on the paid result.** Read the signed result, recompute its digest, and recover the signer:

```bash
near contract call-function as-read-only oracle-1794575543.enzure-council-a-1794575224.testnet \
  get_signed_result json-args '{"assertion_id":3,"hook_index":0}' network-config testnet now
cast keccak 0x5686139c8eb1de3c99cb20b4b2940863b1c8903c4e9c388ad77ceb4908cb41d40000000000000000000000000000000000000000000000000000000000014a340000000000000000000000005fbdb2315678afecb367f032d93f642f64180aa30000000000000000000000000dcd1bf9a1b36ce34237eeafef220932846bcd82000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000016737fd606296d5e1ea3ac20f470896757bf8fcd0b84b81da863b54db62178caa2059845b5396d1e65ad0168146abf146ecedca64315b00d884b9ffcb9accdb21000000000000000000000000000000000000000000000000000000006af71589
cast wallet verify --no-hash --address 0xf4848c5be2f0bc003a4f071f10ca3a7101a41e5a \
  0x4fe50bc7f98438018280dd05da0b63075e3702864eaa637799a1716f5a6992c7 \
  0x701ade53bdd2caa5a3863cc694f7857f71996aa4012324155eb2db7a6383f75b65c06270988e989f14c5147dfbeaf624d44aee3f83319ce9f6a45bdb41f174291c
```

The first prints the result with its `message`, `digest`, `r`, `s` and `v` (28). `cast keccak` of the `message` prints the `digest`, `0x4fe50bc7…92c7`. `cast wallet verify` prints `Validation succeeded. Address 0xF4848C5Be2F0bC003a4f071F10CA3a7101a41e5A signed this message.` (the signature argument is `r`, `s` and `v` = `0x1c`). That address is the oracle's derived address; after `cd typescript && vp install`, `node scripts/oracle-evm-address.mts oracle-1794575543.enzure-council-a-1794575224.testnet` derives it from the signer's `derived_public_key` and prints `"address": "0xf4848c5be2f0bc003a4f071f10ca3a7101a41e5a"`.

**6. Read the DAO's proposals.**

```bash
near contract call-function as-read-only enzure-1794575224.sputnikv2.testnet \
  get_proposals json-args '{"from_index":0,"limit":10}' network-config testnet now
```

You see proposals 0 to 4, all `"status": "Approved"`: register the attested key, publish Prompt Template v1, set the demo config, `resolve_appeal` for Assertion 1, and `upgrade`. `get_registered_keys` and `get_prompt_template` on the oracle show the results of proposals 0 and 1.

**7. Open the finished transactions** in the tables under [Recorded testnet runs](deployments.md#recorded-testnet-runs). Each link opens NearBlocks.
