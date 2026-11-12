# Chain Signatures "cross-chain hooks" for an optimistic oracle on NEAR

Research date: 2026-11-12. Hackathon development ends 2026-11-14T23:59Z (HACKATHON.md), so roughly 2.5 days remain.

## TL;DR verdict

- **Feasible on testnet end to end, and small.** A NEAR contract that calls `v1.signer-prod.testnet.sign` gets an ECDSA signature from a key derived from its own account id. A Solidity contract on Base Sepolia can check that signature with `ecrecover` against a fixed address. NEAR's Omni Bridge already ships this pattern in production (details below).
- **Recommended design: option (b), signed attestations.** The oracle contract signs `keccak256(abi.encode(tag, chainId, receiver, assertionId, truthful, claimHash, settledAt))`. Any relayer submits the signature to an EVM receiver and pays the gas. With this design there is no destination nonce, no gas funding for the derived address, and no transaction builder inside the NEAR contract.
- **Drop these from the hackathon scope:** option (a) (contract signs full EVM transactions), Shade Agents (deprecated in the NEAR docs since 2026-04-19), NEAR Intents (mainnet only, and the oracle does not need it), Solana and Bitcoin hooks.
- **New MPC capability to know about:** the MPC contract now has `verify_foreign_transaction`. The MPC nodes read an EVM log, and on testnet they read Base Sepolia. A NEAR contract could use it to accept assertion requests from Base, or to prove a hook was delivered. It works on testnet but adds a lot of encoding work. Treat it as a stretch goal, not the core.
- **Track fit:** `open` is strong. `defi` and `agents` are good if the demo includes a real consumer contract (`defi`) or an AI agent that bonds and disputes (`agents`). `business` is weak.

---

## 1. Facts about Chain Signatures (verified 2026-11-12)

Each fact lists how it was checked: a live RPC view call, the source code of `near/mpc` at commit `880161917c` (2026-11-11), or the docs.

### Contracts and network

| Fact | Testnet | Mainnet | Source |
|---|---|---|---|
| MPC signer account | `v1.signer-prod.testnet` | `v1.signer` | [docs: implementation](https://docs.near.org/chain-abstraction/chain-signatures/implementation), [near/mpc contract README](https://github.com/near/mpc/blob/main/crates/contract/README.md) |
| Contract version (`version` view) | `3.18.0` | `3.18.0` | live RPC; [release 3.18.0](https://github.com/near/mpc/releases/tag/3.18.0) (2026-10-28) |
| Protocol state | `Running`, 16 participants, threshold 11 | `Running`, 16 participants, threshold 11 | live `state` view |
| Domain 0 (Secp256k1, Sign) root key | `secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3` | `secp256k1:3tFRbMqmoa6AAALMrEFAYCEoHcqKxeW38YptwowBVBtXK1vo36HDbUWuR6EZmoK4JcH6HDkNMGGqP1ouV7VZUWya` | live `public_key {"domain_id":0}`; same values in chainsig.js `ROOT_PUBLIC_KEYS` |
| Domain 1 (Ed25519, Sign) root key | `ed25519:6vSEtQxrQj6txUMh33WC4ERyCWmNMRTdufDWAaDY3Un2` | `ed25519:G9hwngxWNKdmqMCmU1Yt6LPhFpayJeKFxyAV1HqMNLtF` | live `public_key {"domain_id":1}` |
| Other domains | 2 and 6 = CKD; 3 and 7 = ForeignTx (secp256k1); 4 = Sign secp256k1 and 5 = Sign ed25519, with **different root keys** from 0 and 1 | same layout | live `state` and `public_key` |

Gotcha: the derived address depends on `domain_id`. Pin `domain_id: 0` everywhere: in the NEAR contract, in address derivation, and in the receiver deployment script. Libraries that hard-code root keys assume domains 0 and 1.

### `sign` request format

Source: [`crates/contract/src/api/sign.rs`](https://github.com/near/mpc/blob/main/crates/contract/src/api/sign.rs), [`near-mpc-crypto-types/src/sign.rs`](https://github.com/near/mpc/blob/main/crates/near-mpc-crypto-types/src/sign.rs), contract README.

```json
{ "request": {
    "path": "enzure-hooks-evm-84532",
    "payload_v2": { "Ecdsa": "<64 hex chars = 32 bytes>" },
    "domain_id": 0 } }
```

- The arguments must sit under a `request` key.
- `payload_v2` is `{"Ecdsa": hex32}` or `{"Eddsa": hex of 32..1232 bytes}`. The payload variant must match the domain's scheme.
- The legacy form `{"payload": [u8;32], "key_version": 0}` is still accepted and is read as ECDSA. Omni Bridge uses it. Mixing old and new field names is rejected.
- An ECDSA payload must convert to a secp256k1 scalar. The code uses `Scalar::from_repr`, so the value must be below the curve order. A keccak digest fails this with probability about 2^-128.
- **The signature is over the 32 raw payload bytes, with no extra hashing.** The caller does the hashing. In a NEAR contract that means `env::keccak256_array`.
- **Deposit:** at least 1 yoctoNEAR (`SIGN_DEPOSIT_YOCTONEAR = 1`). The excess is refunded to the predecessor. A cross-contract caller attaches the yocto from its own balance.
- **Gas:** the live `config` sets `sign_call_gas_attachment_requirement_tera_gas = 15` on both networks. The README still says 10 Tgas, so trust the live config. The yield callback reserves 7 Tgas. Omni Bridge attaches 250 Tgas. Tx-bench accounts on both networks attach 20 Tgas and succeed. Attach about 30 Tgas for headroom.
- **Derivation:** `tweak = sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" + predecessor_account_id + "," + path)` and `derived_pk = root_pk + tweak·G` ([`kdf.rs`](https://github.com/near/mpc/blob/main/crates/near-mpc-crypto-types/src/kdf.rs)). The predecessor is the account that calls `sign`. When the oracle contract makes the call, the key belongs to the oracle account. That is the property this idea needs.
  - Verified locally: deriving from `oracle.testnet` with path `evm-1` gives the same result as the live `derived_public_key` view. The EVM address is `0xe5fe8162ce37564318a4248ba192d53763795c2f`. Use it as a test vector.

### Response format (decoded from a real mainnet transaction)

```json
{"scheme":"Secp256k1",
 "big_r":{"affine_point":"031d15fd8a49...cf170a"},
 "s":{"scalar":"4533b2c80f1d...7fdfca"},
 "recovery_id":1}
```

Ed25519 responses look like `{"scheme":"Ed25519","signature":[64 bytes]}`.

The enum uses the tag `#[serde(tag = "scheme")]`. The skill notes in `.agents/skills/near-smart-contracts/rules/chain-signatures.md` show an externally tagged form, `{"Secp256k1": {...}}`, which is out of date.

Converting to an EVM signature ([contract README, "ECDSA signature response"](https://github.com/near/mpc/blob/main/crates/contract/README.md)):
- `r` = bytes `1..33` of `big_r.affine_point`. Drop the 02/03 prefix byte.
- `s` = `s.scalar`. It is already low-s normalized, so OpenZeppelin `ECDSA.recover` accepts it.
- `v` = `recovery_id + 27`.

Omni Bridge's `SignatureResponse::to_bytes` and chainsig.js `toRSV` both do exactly this.

### Yield/resume, latency, timeouts

- `sign` calls `promise_yield_create`. MPC nodes call `respond`, the contract checks the signature against the derived key, and the yield resumes ([sign.rs](https://github.com/near/mpc/blob/main/crates/contract/src/api/sign.rs)). If no response arrives, `return_signature_and_clean_state_on_success` calls `fail_on_timeout`, which panics with a Timeout error. The caller's callback receives `Err(PromiseError)`.
- The yield timeout is 200 blocks ([docs: yield-resume](https://docs.near.org/smart-contracts/anatomy/yield-resume)). Measured block times were 0.593 s on testnet and 0.570 s on mainnet over the last 1000 blocks, so the timeout is about **2 minutes**.
- Measured end-to-end latency, from the `sign` tx block to the final receipt, on `tx-bench` accounts:
  - mainnet: 6–7 blocks, about 4.4 s, for both secp256k1 and ed25519;
  - testnet: 7, 9 and 15 blocks, or 4.2 s, 5.2 s and 9.1 s.
- Measured cost: a direct mainnet `sign` burned about **0.00086 NEAR** in gas. The yield does not burn gas while it waits.
- Duplicate requests (same caller, domain, path and payload) are queued while one is pending, and all of them get the same response. The queue is bounded and rejects overflow with `PendingRequestQueueFull` ([README method table](https://github.com/near/mpc/blob/main/crates/contract/README.md)). Re-requesting the same digest is safe.

### Supported chains

- Signing: any chain that uses secp256k1 ECDSA or ed25519. The docs and chainsig.js have adapters for EVM, Bitcoin, Solana, Cosmos, XRP, Aptos and Sui ([docs overview](https://docs.near.org/chain-abstraction/chain-signatures)).
- Foreign-transaction verification (`get_available_foreign_chains`, live, same list on both networks): Solana, Base, Bnb, Arbitrum, Abstract, Starknet, Polygon, HyperEvm, Aptos, Sui, Avalanche, Fogo. **Ethereum is not in the list.** On testnet the RPC whitelist points at **Base Sepolia**, Arbitrum Sepolia, BSC testnet and Solana devnet (live `allowed_foreign_chain_providers`). EVM extractors are `BlockHash` and `Log { log_index }`. The response carries only `payload_hash` and the signature, so the caller must know the expected values ahead of time (`expected_payload_hash`) ([design doc](https://github.com/near/mpc/blob/main/docs/archive/design/foreign-chain-transactions.md)).

### Libraries (current versions)

| Library | Version | Notes |
|---|---|---|
| [`chainsig.js`](https://github.com/NearDeFi/chainsig.js) (npm) | 1.1.16 (May 2026) | Derives addresses, builds EVM tx payloads, converts MPC responses with `toRSV`. The docs use it. Do not confuse it with `signet.js`, which is a different project (sig-net). |
| [`omni-transaction`](https://github.com/near/omni-transaction-rs) (crates.io) | 0.5.0 | Builds EVM and BTC transactions inside a Rust contract. Only option (a) needs it. |
| `near-mpc-sdk` (crates.io) | 0.0.1 | Typed `SignRequestBuilder` and foreign-chain request builders from `near/mpc`. Optional, and early. |
| `@neardefi/shade-agent-js` | 2.2.0 | **Deprecated.** The docs say not to use the Shade Agent Framework, which has not been maintained since 2026-04-19 ([docs](https://docs.near.org/ai/shade-agents/getting-started/introduction)). |

---

## 2. Hook delivery design options

The setting: an assertion settles on NEAR, and the result must reach a consumer on another chain. The oracle contract's derived key is the root of trust on that chain.

### (a) The contract signs a full EVM transaction and a relayer only broadcasts it

The flow: NEAR builds an EIP-1559 tx (for example with `omni-transaction`), hashes it, signs it through MPC, and anyone broadcasts the raw tx. On the destination chain, `msg.sender` is the derived address.

| Concern | Assessment |
|---|---|
| Nonce | The NEAR contract cannot read the destination nonce. A keeper has to supply it, or the contract tracks it itself and drifts after any failure. Nonces are sequential per address, so one stuck or dropped tx blocks every later hook on that chain. |
| Gas price | The keeper supplies fee fields. The contract has to cap them, or a malicious keeper can drain the derived address. Price spikes require re-signing a replacement tx. |
| Gas funding | The derived address needs native gas on every destination chain, and someone has to keep it topped up. |
| Replay | EIP-155 `chainId` in the tx plus the nonce. Safe. |
| Failure handling | A reverted tx still uses up its nonce. There is no idempotent retry, and recovery needs a new nonce and a new signature. |
| Upside | Consumers need no signature code. Any contract with `onlyOwner` or a role works if the derived address holds that role. This is the only option that works for chains with no programmable receiver, such as moving BTC. |

### (b) The contract signs an attestation and an EVM receiver verifies it (recommended)

The flow: NEAR computes a 32-byte digest over the settled result and signs it through MPC, then stores the signature in state and emits an event. Anyone calls `Receiver.deliver(result, sig)` on the EVM chain and pays the gas. The receiver checks `ecrecover(digest) == oracleSigner`.

| Concern | Assessment |
|---|---|
| Nonce | There is none. The `assertionId` is the unique key, and delivery is idempotent. |
| Gas funding | The relayer pays destination gas. The derived address never holds funds. |
| Replay | Bind `chainId` (`block.chainid`), `address(this)` of the receiver, a version tag, and `assertionId`. Use a per-chain derivation path as well, which the [docs](https://docs.near.org/chain-abstraction/chain-signatures) recommend as the robust rule. Keep `delivered[assertionId]` on the receiver. |
| Failure handling | MPC timeout: the NEAR callback gets `Err`, marks the hook retryable, and someone calls `dispatch_hook` again. EVM revert or reorg: resubmit the same signature. Consumer callback reverts: the receiver stores the result first and then calls the consumer in `try/catch` with a gas cap, so a broken consumer cannot block delivery. |
| Relayer incentive | Hackathon: run your own relayer script. Production: pay a bounty on NEAR from the assertion fee, released on proof of delivery. The proof could come from MPC `verify_foreign_transaction` on Base, or a fee could be paid out on the destination chain. |
| Precedent | [Omni Bridge](https://github.com/Near-One/omni-bridge) uses this pattern. The NEAR side computes `env::keccak256_array(borsh(payload))` and calls `sign`, and a callback logs `SignTransferEvent{signature, payload}`. The EVM side runs `OmniBridge.finTransfer`, which rebuilds the bytes, takes keccak, and requires `ECDSA.recover(hash, sig) == nearBridgeDerivedAddress`. It also keeps a `completedTransfers[nonce]` mapping. `nearBridgeDerivedAddress` is computed off-chain at deploy time with path `"bridge-1"` (`evm/utils/kdf.ts`). |

### (c) A Shade Agent (TEE) builds and signs

The NEAR docs mark the Shade Agent Framework as deprecated, unmaintained since 2026-04-19, and say not to use it for new projects. It also adds a TEE deployment, attestation registration and an off-chain service, and none of that is needed to deliver a boolean. **Rejected.** If TEE-hosted AI resolution matters for the pitch, use NEAR AI Cloud for attested inference on the *resolution* side. That is a separate question from delivery.

### Recommendation

Use **(b)** with one receiver contract per destination chain. The receiver stores results, and consumers either read them or register for a UMA-style callback. The callback can mirror UMA OOv3's `OptimisticOracleV3CallbackRecipientInterface.assertionResolvedCallback(bytes32 assertionId, bool assertedTruthfully)` (verified in [UMAprotocol/protocol](https://github.com/UMAprotocol/protocol/blob/master/packages/core/contracts/optimistic-oracle-v3/interfaces/OptimisticOracleV3CallbackRecipientInterface.sol)), so existing OOv3 consumer code ports over.

---

## 3. Design for option (b)

### Message

All fields are fixed-width, so `abi.encode` is just 32-byte words concatenated. That makes it easy to reproduce in Rust without an ABI library.

```
digest = keccak256(abi.encode(
  bytes32 TAG,          // keccak256("enzure.hook.v1")
  uint256 chainId,      // 84532 Base Sepolia, 11155111 Ethereum Sepolia
  address receiver,     // left-padded to 32 bytes
  bytes32 assertionId,
  bool    truthful,     // uint256 0/1
  bytes32 claimHash,    // keccak of the claim bytes, so consumers can check what was asserted
  uint64  settledAt     // NEAR block timestamp in seconds, padded to 32 bytes
))
```

EIP-712 is optional. It only matters if a wallet has to display the message. Here no human signs, so a domain-tagged raw digest (the Omni Bridge approach) is enough.

### NEAR side (sketch, not a full implementation)

```rust
const MPC_SIGN_GAS: Gas = Gas::from_tgas(30);   // live minimum is 15
const HOOK_CB_GAS: Gas = Gas::from_tgas(10);

// Permissionless. The contract builds the payload from settled state only.
// Never expose a method that signs caller-supplied bytes.
pub fn dispatch_hook(&mut self, assertion_id: [u8; 32], hook_idx: u32) -> Promise {
    let a = self.assertions.get(&assertion_id).expect("unknown");
    require!(a.is_settled(), "not settled");
    let hook = a.hooks[hook_idx as usize].clone();
    require!(hook.status == HookStatus::Pending, "signing or signed"); // dedupe
    self.set_hook_status(&assertion_id, hook_idx, HookStatus::Signing);

    let digest = env::keccak256_array(&encode_words(&[
        TAG, u256(hook.chain_id), addr32(hook.receiver), assertion_id,
        u256(a.truthful as u64), a.claim_hash, u256(a.settled_at_secs),
    ]));
    let args = json!({ "request": {
        "path": format!("enzure-hooks-evm-{}", hook.chain_id),
        "payload_v2": { "Ecdsa": hex::encode(digest) },
        "domain_id": 0 }}).to_string().into_bytes();

    Promise::new(self.mpc.clone())
        .function_call("sign".into(), args, NearToken::from_yoctonear(1), MPC_SIGN_GAS)
        .then(Self::ext(env::current_account_id()).with_static_gas(HOOK_CB_GAS)
              .on_hook_signed(assertion_id, hook_idx, digest))
}

#[private]
pub fn on_hook_signed(&mut self, assertion_id: [u8;32], hook_idx: u32, digest: [u8;32],
    #[callback_result] r: Result<MpcSig, PromiseError>) {
    // Do not panic here. Panicking would leave the status stuck at Signing.
    match r {
        Ok(sig) => self.set_hook_status(&assertion_id, hook_idx,
                       HookStatus::Signed { digest, rsv: sig.to_rsv() }), // r=big_r[1..33], s, v=rid+27
        Err(_)  => self.set_hook_status(&assertion_id, hook_idx, HookStatus::Pending), // retryable
    }
    // emit a NEP-297 event so the relayer can pick it up; also expose a view method
}
```

`MpcSig` should be `{ big_r: { affine_point }, s: { scalar }, recovery_id }`. The `scheme` field is ignored because serde accepts unknown fields by default, which is what Omni Bridge relies on.

### EVM receiver (sketch)

```solidity
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IHookConsumer { function assertionResolvedCallback(bytes32 id, bool truthful) external; }

contract EnzureReceiver {
    bytes32 public constant TAG = keccak256("enzure.hook.v1");
    address public immutable oracleSigner;      // derived from (oracle.near account, path, domain 0)
    struct Result { bool truthful; bytes32 claimHash; uint64 settledAt; bool set; }
    mapping(bytes32 => Result) public results;
    mapping(bytes32 => address) public callbackOf; // optional consumer registration

    event Delivered(bytes32 indexed assertionId, bool truthful, bytes32 claimHash);

    constructor(address signer) { oracleSigner = signer; }

    function deliver(bytes32 id, bool truthful, bytes32 claimHash, uint64 settledAt, bytes calldata sig) external {
        if (results[id].set) return;                                   // idempotent
        bytes32 digest = keccak256(abi.encode(TAG, block.chainid, address(this), id, truthful, claimHash, settledAt));
        require(ECDSA.recover(digest, sig) == oracleSigner, "bad sig"); // 65-byte r||s||v
        results[id] = Result(truthful, claimHash, settledAt, true);
        emit Delivered(id, truthful, claimHash);
        address cb = callbackOf[id];
        if (cb != address(0)) {
            try IHookConsumer(cb).assertionResolvedCallback{gas: 200_000}(id, truthful) {} catch {}
        }
    }
}
```

How `callbackOf` gets set is a product decision. Options include `assertionId` folding the consumer address in, or consumers registering with `register(id)` before delivery. Keep `oracleSigner` immutable for the demo. In production you would need a rotation path, because an MPC root key change or a domain migration would change the address.

### Address derivation for the deploy script

Either way below gives the same result, so pick one.

1. View call: `derived_public_key {"path":"enzure-hooks-evm-84532","predecessor":"<oracle>.testnet","domain_id":0}` on `v1.signer-prod.testnet`. It returns `secp256k1:<base58 of 64 bytes x||y>`. The address is `keccak256(x||y)[12:]`.
2. Offline: chainsig.js `EVM.deriveAddressAndPublicKey(accountId, path)`, or the 30 lines in Omni Bridge `evm/utils/kdf.ts`.

Existing templates: no NEAR-provided generic "Chain Signatures receiver" contract was found. The closest production reference is Omni Bridge `OmniBridge.sol`, specifically `finTransfer` and `nearBridgeDerivedAddress`. The `near-examples/near-multichain` frontend covers option (a) flows such as ETH transfers and `set()` function calls signed by a user account. It does not cover contract-signed attestations.

---

## 4. NEAR Intents: relevant or not?

It is not needed for the core loop, so leave it out of the hackathon build.

- Q-007 in HACKATHON.md says there is no Intents testnet now or planned. Any integration would be mainnet with real (if tiny) funds, while everything else here runs on testnet.
- The places it could fit:
  - paying out bonds or rewards to a winner on another chain, through a 1Click swap from the NEAR-held bond token to the winner's chain;
  - letting relayers be paid in any asset.
  Both are features on top of the oracle. Chain Signatures is what makes the hooks themselves work.
- If the team wants the `defi` hint keyword, the cheapest honest option is an off-path script. It takes a settled payout and shows a `dry: true` 1Click quote, or does one real mainnet swap of a few cents. Label it clearly as mainnet-only.

---

## 5. Testnet feasibility, costs and gotchas

### End-to-end path on testnet

1. Deploy the oracle contract to a NEAR testnet account (free faucet).
2. Compute the derived EVM address for path `enzure-hooks-evm-84532` and deploy `EnzureReceiver(signer)` to **Base Sepolia** (chainId 84532). The derived address needs no ETH.
3. Run assert → short liveness (for example 60 s for the demo) → settle → `dispatch_hook`. The MPC call took 4–9 s in testnet measurements.
4. A relayer (TS with near-kit or near-api-js plus viem) polls the hook view or event, packs `r||s||v`, and calls `deliver`.
5. A consumer contract on Base Sepolia reacts, for example an escrow releases funds or a market resolves.

Prefer Base Sepolia over Ethereum Sepolia. Signing works for both, but Base Sepolia is also the network the testnet MPC can *read* if you add the inbound stretch goal, and its gas is cheaper.

### Costs

| Item | Cost |
|---|---|
| NEAR testnet gas and deposits | free (faucet) |
| MPC `sign` | 1 yocto deposit, refunded above 1, plus about 0.0009 NEAR in gas (measured on mainnet) |
| Storage per signed hook (about 200 B) | about 0.002 NEAR. Charge it to the asserter's bond or a storage deposit |
| Base Sepolia `deliver` | faucet ETH. Expected around 60–100k gas with a callback. **This is an estimate, not measured** |

### Gotchas

- **Trust root = NEAR account, not code.** Whoever can deploy code to the oracle account can sign any result for every receiver. For the demo that is acceptable, but say so in the README. In production, lock the account (remove its full-access keys) or put upgrades behind a DAO.
- **Never expose a generic "sign these bytes" method** on the oracle. The derived key must only ever sign digests the contract builds from settled state.
- **Domain ID pinning.** Domains 0 and 4 are both secp256k1 Sign domains with different root keys. Using the wrong one gives a different address.
- **Response shape.** The response is internally tagged (`"scheme":"Secp256k1"`), `big_r` is a 33-byte compressed point (drop its first byte to get `r`), and `v = recovery_id + 27`. The repo's skill notes describe an older shape.
- **Gas.** `sign` needs at least 15 Tgas (live config), not the 10 Tgas the README states. Attach about 30 Tgas, plus your callback gas.
- **Timeouts.** After about 2 minutes (200 blocks) the callback gets `Err`. Do not panic in it. Reset the hook to `Pending` so it can be retried. Mark `Signing` before calling MPC so dispatch cannot be spammed. The MPC also bounds duplicate queues and returns `PendingRequestQueueFull` on overflow.
- **Local tests.** `near-sandbox` has no MPC network. Deploy a mock signer contract that signs with a known test key and returns the same JSON shape, and use it for sandbox and Foundry tests. Run the real MPC only on testnet.
- **Hash once.** The MPC signs the raw 32 bytes. Do not use `toEthSignedMessageHash` on the EVM side unless the NEAR side applied the EIP-191 prefix too.
- **Solana hooks** would need ed25519 verification through the Ed25519 precompile and instruction introspection. **Bitcoin hooks** have no programmable receiver and would need option (a) with UTXO and fee handling. Both are out of scope.
- **AI resolution** is a separate trust question. If disputes are settled by one AI resolver key, the oracle is only as secure as that key, and hooks only carry its result faithfully. Present the AI as the dispute resolver that a DVM-style fallback could replace. Do not claim trustlessness.

---

## 6. Track fit

| Track | Fit | Why |
|---|---|---|
| `open` | Strong | Chain abstraction is the listed hint, and an oracle on NEAR that delivers to EVM through MPC is a real chain-abstraction primitive. |
| `defi` | Good, if the demo includes a consumer | The hint lists CHAIN SIGNATURES. The track text centers on settling through NEAR Intents, which this design does not use. Show a consumer contract on Base Sepolia (insurance, prediction market or escrow) that settles from the hook. |
| `agents` | Good, if an AI agent is a real economic actor | "Agents that earn": an agent that posts bonds on assertions, disputes bad ones, and earns the loser's bond. CHAIN SIGNATURES is a listed hint. A resolver-only AI is weaker. |
| `business` | Weak | The track wants AI-run businesses with treasury and payments. An oracle fee model is a stretch. |

---

## 7. Hackathon scope recommendation (about 2.5 days left)

**Build (must have):**
1. A NEAR oracle contract on testnet:
   - `assert(claim, bond, liveness, hooks[])`, `dispute`, `settle`, and a resolver path for disputes (an authorized AI or agent account);
   - `dispatch_hook` and `on_hook_signed`, as sketched above;
   - a view method `get_hook(assertion_id, idx)`.
2. `EnzureReceiver` plus one demo consumer on Base Sepolia, with Foundry tests against a mock signer key.
3. A relayer script (TS, near-kit or near-api-js, and viem) that polls signed hooks and calls `deliver`.
4. A README with "do X, see Y" steps and the derived address shown, plus a demo video. The video should show one assertion on NEAR flipping a contract on Base, with tx links on both explorers.

**Skip:** option (a), Shade Agents, NEAR Intents, Solana, Bitcoin, mainnet deployment.

**Stretch, only if the core works by day 2:**
- Inbound requests: a Base Sepolia consumer emits `AssertionRequested`, and the NEAR oracle accepts it through MPC `verify_foreign_transaction` with the `Log` extractor and `expected_payload_hash`. This is the most distinctive NEAR-only feature, but the borsh `ForeignTxSignPayloadV1` encoding takes real effort. Budget at least half a day and use `near-mpc-sdk`.
- A relayer bounty paid on NEAR.

---

## Sources

- NEAR docs: [Chain Signatures overview](https://docs.near.org/chain-abstraction/chain-signatures), [Signing transactions / implementation](https://docs.near.org/chain-abstraction/chain-signatures/implementation), [Yield and resume](https://docs.near.org/smart-contracts/anatomy/yield-resume), [Tools for AI agents (Shade Agent deprecation)](https://docs.near.org/ai/shade-agents/getting-started/introduction)
- near/mpc at `880161917c`: [contract README](https://github.com/near/mpc/blob/main/crates/contract/README.md), [sign.rs](https://github.com/near/mpc/blob/main/crates/contract/src/api/sign.rs), [common.rs (preconditions, deposit)](https://github.com/near/mpc/blob/main/crates/contract/src/api/common.rs), [kdf.rs](https://github.com/near/mpc/blob/main/crates/near-mpc-crypto-types/src/kdf.rs), [foreign-chain design](https://github.com/near/mpc/blob/main/docs/archive/design/foreign-chain-transactions.md), [release 3.18.0](https://github.com/near/mpc/releases/tag/3.18.0)
- Live RPC views on `v1.signer-prod.testnet` and `v1.signer` (`version`, `config`, `state`, `public_key`, `derived_public_key`, `get_available_foreign_chains`, `allowed_foreign_chain_providers`), run 2026-11-12
- Latency and cost samples: mainnet txs `PEp51z6FZv8pxb2ggQcRrmNrwsNPFTgxaEEZKsnN46K` and `BHyPezxFcbmkFxefpxA7qRTZZkhKm8kHCUtYiVSdmgvn` (`tx-bench.near`); testnet txs `4ozVKDALtPQVvdQFtbXWTrRRJjC6JjjvkzBvS5NMxdPR`, `B3iB5gEpqfNyRTLHtvXJBnKmcC2fTjLMh5umNA7T5vDG` and `APynYYkUNPsoyneZqF4JyVMhuB53t75bx9hmZJgryLq5` (`tx-bench.testnet`)
- [chainsig.js](https://github.com/NearDeFi/chainsig.js) (`src/constants.ts`, `src/utils/cryptography.ts`)
- [Omni Bridge](https://github.com/Near-One/omni-bridge): `near/omni-bridge/src/lib.rs` (`sign_transfer`), `near/omni-types/src/mpc_types.rs` (`SignatureResponse::to_bytes`), `evm/src/omni-bridge/contracts/OmniBridge.sol` (`finTransfer`), `evm/utils/kdf.ts`
- [UMA OOv3 callback interface](https://github.com/UMAprotocol/protocol/blob/master/packages/core/contracts/optimistic-oracle-v3/interfaces/OptimisticOracleV3CallbackRecipientInterface.sol)
- HACKATHON.md (Q-007, Q-010, tracks table)
