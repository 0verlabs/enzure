//! EVM Hooks: a settled Assertion's outcome, signed for an EVM chain through
//! Chain Signatures (ADR 0002). The oracle signs only result messages it builds
//! from settled state; it has no method that signs bytes a caller supplies.
//!
//! The result message is `keccak256` of nine 32-byte words, which is exactly
//! Solidity's `abi.encode(bytes32, uint256, address, address, uint256, bool,
//! bytes32, bytes32, uint256)` of: the version tag `keccak256("enzure.hook.v1")`,
//! chain id, Receiver, Consumer, Assertion id, outcome, Claim hash, sha256 of
//! the Asserter's NEAR account id, and settlement time in Unix seconds. The
//! signer signs that 32-byte digest as is, with no EIP-191 prefix, so a Receiver
//! checks it with `ecrecover(digest, v, r, s)`.
use near_sdk::json_types::U64;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::{AccountId, Gas, GasWeight, NearToken, Promise, PromiseError, env, near, require};

use crate::events::Event;
use crate::hooks::{HookView, StoredHook};
use crate::{Assertion, AssertionState, NS_PER_SEC, Oracle, OracleExt};

/// The Chain Signatures signer on NEAR testnet; mainnet's is `v1.signer`.
pub const DEFAULT_EVM_SIGNER: &str = "v1.signer-prod.testnet";
/// One derivation path for every EVM chain, so the oracle has the same derived
/// EVM address on all of them.
pub const EVM_DERIVATION_PATH: &str = "enzure-hooks-evm";
/// The signer's secp256k1 domain.
pub const EVM_SIGNER_DOMAIN_ID: u64 = 0;
/// Hashed with keccak256 to make the result message's first word.
pub const RESULT_MESSAGE_VERSION: &str = "enzure.hook.v1";

/// Gas for the signer's `sign`, which needs at least 15 Tgas; the call also gets
/// the transaction's unused gas.
const GAS_FOR_SIGN: Gas = Gas::from_tgas(30);
const GAS_FOR_ON_HOOK_SIGNED: Gas = Gas::from_tgas(15);
/// Least gas `sign_hook` accepts: the signer's share, the callback and this call.
const MIN_GAS_FOR_SIGN_HOOK: Gas = Gas::from_tgas(60);
/// A signer response is about 200 bytes; anything far larger is not one.
const MAX_SIGNER_RESPONSE_BYTES: usize = 1024;

/// An EVM Hook as the Asserter names it in `assert_claim`: the chain, that
/// chain's Receiver and the Consumer the Receiver calls. Addresses are `0x`
/// followed by 40 hex characters, in any case.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct EvmHook {
    pub chain_id: u64,
    pub receiver: String,
    pub consumer: String,
}

/// An EVM Hook as the oracle stores it: parsed destinations and signing state.
/// About 115 bytes with a signature, under `HOOK_STORAGE_BYTES`.
#[near(serializers = [borsh])]
pub(crate) struct StoredEvmHook {
    chain_id: u64,
    receiver: [u8; 20],
    consumer: [u8; 20],
    status: SigningStatus,
}

#[near(serializers = [borsh])]
enum SigningStatus {
    Unsigned,
    /// A `sign` request is in flight; its callback sets the next status.
    Signing,
    Signed(EvmSignature),
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy)]
struct EvmSignature {
    r: [u8; 32],
    s: [u8; 32],
    /// `recovery_id + 27`.
    v: u8,
}

/// Where an EVM Hook is in signing.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EvmHookStatus {
    /// Not signed; `sign_hook` can start signing once the Assertion settles,
    /// including after a failed or timed-out request.
    Unsigned,
    /// A signing request is in flight.
    Signing,
    /// Signed; `get_signed_result` returns the signature.
    Signed,
}

/// A signed result, ready for a Relayer to deliver to the Receiver. Byte
/// fields are `0x` lowercase hex.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignedResult {
    /// The version tag word, `keccak256("enzure.hook.v1")`.
    pub version: String,
    pub chain_id: u64,
    pub receiver: String,
    pub consumer: String,
    pub assertion_id: u64,
    pub outcome: bool,
    /// sha256 of the Claim.
    pub claim_hash: String,
    pub asserter: AccountId,
    /// sha256 of the Asserter's account id.
    pub asserter_hash: String,
    /// Settlement time in Unix seconds.
    pub settled_at: U64,
    /// The nine encoded words, 288 bytes.
    pub message: String,
    /// keccak256 of `message`; the bytes the signer signed.
    pub digest: String,
    pub r: String,
    pub s: String,
    /// 27 or 28.
    pub v: u8,
}

/// Which signer the oracle uses and how, as `get_evm_signer` returns it. The
/// oracle's EVM address is derived from the signer's root key for this domain,
/// the oracle's account id and this path.
#[near(serializers = [json])]
pub struct EvmSignerView {
    pub signer: AccountId,
    pub path: String,
    pub domain_id: u64,
}

/// The result message for one EVM Hook of a settled Assertion.
#[derive(Clone, Debug, PartialEq)]
pub struct ResultMessage {
    pub chain_id: u64,
    pub receiver: [u8; 20],
    pub consumer: [u8; 20],
    pub assertion_id: u64,
    pub outcome: bool,
    pub claim_hash: [u8; 32],
    pub asserter: AccountId,
    /// Unix seconds.
    pub settled_at: u64,
}

impl ResultMessage {
    /// The nine 32-byte words, as Solidity's `abi.encode` lays them out.
    pub fn encode(&self) -> Vec<u8> {
        let mut message = Vec::with_capacity(9 * 32);
        message.extend_from_slice(&env::keccak256_array(RESULT_MESSAGE_VERSION.as_bytes()));
        message.extend_from_slice(&uint_word(self.chain_id));
        message.extend_from_slice(&address_word(&self.receiver));
        message.extend_from_slice(&address_word(&self.consumer));
        message.extend_from_slice(&uint_word(self.assertion_id));
        message.extend_from_slice(&uint_word(u64::from(self.outcome)));
        message.extend_from_slice(&self.claim_hash);
        message.extend_from_slice(&env::sha256_array(self.asserter.as_bytes()));
        message.extend_from_slice(&uint_word(self.settled_at));
        message
    }

    /// keccak256 of the encoded message: what the signer signs.
    pub fn digest(&self) -> [u8; 32] {
        env::keccak256_array(self.encode())
    }
}

impl EvmHook {
    /// Checks the destinations and returns the Hook to store. `field` names the
    /// Hook in panic messages.
    pub(crate) fn to_stored(&self, field: &str) -> StoredEvmHook {
        require!(
            self.chain_id > 0,
            format!("{field}.chain_id must be above zero")
        );
        StoredEvmHook {
            chain_id: self.chain_id,
            receiver: parse_address(&format!("{field}.receiver"), &self.receiver),
            consumer: parse_address(&format!("{field}.consumer"), &self.consumer),
            status: SigningStatus::Unsigned,
        }
    }
}

impl StoredEvmHook {
    pub(crate) fn view(&self) -> HookView {
        HookView::Evm {
            chain_id: self.chain_id,
            receiver: to_hex0x(&self.receiver),
            consumer: to_hex0x(&self.consumer),
            status: match self.status {
                SigningStatus::Unsigned => EvmHookStatus::Unsigned,
                SigningStatus::Signing => EvmHookStatus::Signing,
                SigningStatus::Signed(_) => EvmHookStatus::Signed,
            },
        }
    }

    /// The result message for this Hook of `assertion`, if it has settled.
    fn result_message(&self, assertion_id: u64, assertion: &Assertion) -> Option<ResultMessage> {
        let AssertionState::Settled {
            outcome,
            settled_at_ns,
        } = assertion.state
        else {
            return None;
        };
        Some(ResultMessage {
            chain_id: self.chain_id,
            receiver: self.receiver,
            consumer: self.consumer,
            assertion_id,
            outcome,
            claim_hash: assertion.claim_hash,
            asserter: assertion.asserter.clone(),
            settled_at: settled_at_ns / NS_PER_SEC,
        })
    }
}

#[near]
impl Oracle {
    /// Starts signing an EVM Hook of a settled Assertion. Anyone can call it,
    /// attaching the Chain Signatures deposit (1 yoctoNEAR today), which is
    /// passed on to the signer (and returned to the caller if the signer's call
    /// fails), and 100 Tgas (at least 60). The Hook is marked as
    /// signing first, so another call is rejected until the signer answers; if
    /// it fails or times out, the Hook can be signed again. The transaction's
    /// result is true if the Hook was signed.
    #[payable]
    pub fn sign_hook(&mut self, assertion_id: u64, hook_index: u32) -> Promise {
        let deposit = env::attached_deposit();
        require!(
            !deposit.is_zero(),
            "Attach the Chain Signatures deposit, at least 1 yoctoNEAR"
        );
        require!(
            env::prepaid_gas() >= MIN_GAS_FOR_SIGN_HOOK,
            format!(
                "Attach at least {} gas to sign a Hook",
                MIN_GAS_FOR_SIGN_HOOK.as_gas()
            )
        );
        let assertion = self
            .assertions
            .get_mut(&assertion_id)
            .unwrap_or_else(|| env::panic_str(&format!("Assertion {assertion_id} not found")));
        let Some(StoredHook::Evm(hook)) = assertion.hooks.get(hook_index as usize) else {
            no_evm_hook(assertion_id, hook_index)
        };
        let Some(message) = hook.result_message(assertion_id, assertion) else {
            env::panic_str(&format!("Assertion {assertion_id} is not settled"))
        };
        match hook.status {
            SigningStatus::Unsigned => {}
            SigningStatus::Signing => env::panic_str("This Hook is already being signed"),
            SigningStatus::Signed(_) => env::panic_str("This Hook is already signed"),
        }
        if let Some(StoredHook::Evm(hook)) = assertion.hooks.get_mut(hook_index as usize) {
            hook.status = SigningStatus::Signing;
        }

        let args = json!({
            "request": {
                "path": EVM_DERIVATION_PATH,
                "payload_v2": { "Ecdsa": to_hex(&message.digest()) },
                "domain_id": EVM_SIGNER_DOMAIN_ID,
            }
        });
        Promise::new(self.evm_signer.clone())
            .function_call_weight(
                "sign",
                args.to_string().into_bytes(),
                deposit,
                GAS_FOR_SIGN,
                GasWeight(1),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_HOOK_SIGNED)
                    .with_unused_gas_weight(0)
                    .on_hook_signed(
                        assertion_id,
                        hook_index,
                        Some(env::predecessor_account_id()),
                        Some(deposit),
                    ),
            )
    }

    /// Stores the signer's answer, or returns the Hook to unsigned if the
    /// request failed, timed out or returned something unreadable. If the
    /// signer's call failed, its deposit came back to the oracle, and is sent
    /// on to `caller`, the account that called `sign_hook`. `caller` and
    /// `deposit` are optional so a request started before this version still
    /// lands. Never panics, so the Hook never stays stuck in signing. Returns
    /// true if it was signed.
    #[private]
    pub fn on_hook_signed(
        &mut self,
        assertion_id: u64,
        hook_index: u32,
        caller: Option<AccountId>,
        deposit: Option<NearToken>,
    ) -> bool {
        let signature = if env::promise_results_count() == 1 {
            match env::promise_result_checked(0, MAX_SIGNER_RESPONSE_BYTES) {
                Ok(bytes) => parse_signer_response(&bytes).ok_or("invalid_response"),
                Err(PromiseError::Failed) => {
                    if let (Some(caller), Some(deposit)) = (caller, deposit) {
                        refund(caller, deposit);
                    }
                    Err("signer_failed")
                }
                // The signer answered, and kept the deposit, with something far too long.
                Err(_) => Err("signer_failed"),
            }
        } else {
            Err("signer_failed")
        };
        let Some(assertion) = self.assertions.get_mut(&assertion_id) else {
            return false;
        };
        let Some(StoredHook::Evm(hook)) = assertion.hooks.get_mut(hook_index as usize) else {
            return false;
        };
        match signature {
            Ok(signature) => {
                hook.status = SigningStatus::Signed(signature);
                if let Some(signed_result) = self.signed_result(assertion_id, hook_index) {
                    Event::EvmHookSigned {
                        assertion_id,
                        hook_index,
                        signed_result,
                    }
                    .emit();
                }
                true
            }
            Err(reason) => {
                hook.status = SigningStatus::Unsigned;
                Event::EvmHookSigningFailed {
                    assertion_id,
                    hook_index,
                    reason: reason.to_string(),
                }
                .emit();
                false
            }
        }
    }

    /// An EVM Hook's signed result, for a Relayer to deliver to the Receiver;
    /// null until the Hook is signed. Panics if the Assertion has no EVM Hook at
    /// `hook_index`.
    pub fn get_signed_result(&self, assertion_id: u64, hook_index: u32) -> Option<SignedResult> {
        let assertion = self.assertion(assertion_id);
        if !matches!(
            assertion.hooks.get(hook_index as usize),
            Some(StoredHook::Evm(_))
        ) {
            no_evm_hook(assertion_id, hook_index);
        }
        self.signed_result(assertion_id, hook_index)
    }

    /// The signer the oracle asks, with the path and domain it signs under.
    /// The oracle's EVM address is derived from these and the oracle's account
    /// id; `scripts/oracle-evm-address.mts` prints it.
    pub fn get_evm_signer(&self) -> EvmSignerView {
        EvmSignerView {
            signer: self.evm_signer.clone(),
            path: EVM_DERIVATION_PATH.to_string(),
            domain_id: EVM_SIGNER_DOMAIN_ID,
        }
    }
}

impl Oracle {
    fn signed_result(&self, assertion_id: u64, hook_index: u32) -> Option<SignedResult> {
        let assertion = self.assertions.get(&assertion_id)?;
        let Some(StoredHook::Evm(hook)) = assertion.hooks.get(hook_index as usize) else {
            return None;
        };
        let SigningStatus::Signed(signature) = hook.status else {
            return None;
        };
        let message = hook.result_message(assertion_id, assertion)?;
        let encoded = message.encode();
        Some(SignedResult {
            version: to_hex0x(&encoded[..32]),
            chain_id: message.chain_id,
            receiver: to_hex0x(&message.receiver),
            consumer: to_hex0x(&message.consumer),
            assertion_id,
            outcome: message.outcome,
            claim_hash: to_hex0x(&message.claim_hash),
            asserter_hash: to_hex0x(&encoded[7 * 32..8 * 32]),
            asserter: message.asserter,
            settled_at: U64(message.settled_at),
            digest: to_hex0x(&env::keccak256_array(&encoded)),
            message: to_hex0x(&encoded),
            r: to_hex0x(&signature.r),
            s: to_hex0x(&signature.s),
            v: signature.v,
        })
    }
}

fn no_evm_hook(assertion_id: u64, hook_index: u32) -> ! {
    env::panic_str(&format!(
        "Assertion {assertion_id} has no EVM Hook at index {hook_index}"
    ))
}

/// Sends a failed signing's deposit back to whoever called `sign_hook`, if the
/// oracle can spare it without dipping into its storage stake; a transfer it
/// can't afford would fail the callback.
fn refund(caller: AccountId, deposit: NearToken) {
    let locked = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage()));
    if env::account_balance().saturating_sub(locked) >= deposit {
        Promise::new(caller).transfer(deposit).detach();
    }
}

/// The signer's response for domain 0:
/// `{"scheme":"Secp256k1","big_r":{"affine_point":"02.."},"s":{"scalar":".."},"recovery_id":0}`.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct SignerResponse {
    scheme: Option<String>,
    big_r: AffinePoint,
    s: Scalar,
    recovery_id: u8,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct AffinePoint {
    affine_point: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Scalar {
    scalar: String,
}

/// Converts the signer's response to an EVM signature: `r` is R's x-coordinate
/// (the compressed point without its 02/03 prefix), `s` as given (already low-s)
/// and `v = recovery_id + 27`.
fn parse_signer_response(bytes: &[u8]) -> Option<EvmSignature> {
    let response: SignerResponse = serde_json::from_slice(bytes).ok()?;
    if response.scheme.as_deref().is_some_and(|s| s != "Secp256k1") || response.recovery_id > 1 {
        return None;
    }
    let big_r: [u8; 33] = decode_hex(&response.big_r.affine_point)?;
    if big_r[0] != 0x02 && big_r[0] != 0x03 {
        return None;
    }
    Some(EvmSignature {
        r: big_r[1..].try_into().ok()?,
        s: decode_hex(&response.s.scalar)?,
        v: response.recovery_id + 27,
    })
}

fn parse_address(field: &str, text: &str) -> [u8; 20] {
    let address = text
        .strip_prefix("0x")
        .and_then(decode_hex::<20>)
        .unwrap_or_else(|| {
            env::panic_str(&format!(
                "{field} must be an EVM address: 0x and 40 hex characters"
            ))
        });
    require!(
        address != [0; 20],
        format!("{field} must not be the zero address")
    );
    address
}

fn uint_word(value: u64) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[24..].copy_from_slice(&value.to_be_bytes());
    word
}

fn address_word(address: &[u8; 20]) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(address);
    word
}

fn decode_hex<const N: usize>(hex: &str) -> Option<[u8; N]> {
    if hex.len() != N * 2 || !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn to_hex0x(bytes: &[u8]) -> String {
    format!("0x{}", to_hex(bytes))
}
