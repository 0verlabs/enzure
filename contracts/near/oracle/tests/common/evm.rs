//! Harness for EVM Hook tests: the mock Chain Signatures signer in
//! `tests/contracts/mock_signer`, EVM addresses and signature recovery.
#![allow(dead_code)]

use std::sync::OnceLock;

use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::{AccountId, NearGas, NearToken};
use serde_json::{Value, json};
use sha3::{Digest, Keccak256};

use crate::common::{TestResult, World, build_contract};

/// The mock signer's key; must match `MOCK_SECRET_KEY` in the mock's source.
pub const MOCK_SECRET_KEY: [u8; 32] = [0x11; 32];
/// Base Sepolia.
pub const CHAIN_ID: u64 = 84532;
pub const RECEIVER: &str = "0x1000000000000000000000000000000000000001";
pub const CONSUMER: &str = "0x2000000000000000000000000000000000000002";
pub const BOND: NearToken = NearToken::from_near(1);

static MOCK_SIGNER_WASM: OnceLock<Vec<u8>> = OnceLock::new();

pub fn mock_signer_wasm() -> &'static [u8] {
    MOCK_SIGNER_WASM.get_or_init(|| {
        build_contract(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/contracts/mock_signer/Cargo.toml"
        ))
    })
}

/// A sandbox whose oracle signs through the mock signer at `signer.sandbox`.
pub struct EvmWorld {
    pub world: World,
    pub signer: AccountId,
}

impl EvmWorld {
    pub async fn new() -> TestResult<Self> {
        let world = World::with_init_args(json!({ "evm_signer": "signer.sandbox" })).await?;
        let signer = world
            .deploy("signer", mock_signer_wasm(), Some(("new", json!({}))))
            .await?;
        Ok(Self { world, signer })
    }

    /// Sets the mock signer to `sign`, `fail` or `hang`.
    pub async fn set_mode(&self, mode: &str) -> TestResult {
        self.world
            .call_contract(
                &self.signer,
                &self.signer,
                "set_mode",
                json!({ "mode": mode }),
                NearToken::from_yoctonear(0),
            )
            .await?
            .assert_success();
        Ok(())
    }

    /// Every `sign` request the mock received, oldest first.
    pub async fn signer_requests(&self) -> TestResult<Vec<Value>> {
        self.world
            .view_contract(&self.signer, "requests", json!({}))
            .await
    }

    /// Posts an Assertion with `hooks` and settles it once Liveness ends.
    pub async fn settled_with(&self, asserter: &AccountId, hooks: Value) -> TestResult<u64> {
        let id: u64 = self
            .world
            .post_with_hooks(asserter, BOND, hooks)
            .await?
            .json()?;
        self.world.wait_for_liveness(id).await?;
        self.world.settle(asserter, id).await?.assert_success();
        Ok(id)
    }

    /// Calls `sign_hook` as `caller` with 100 Tgas.
    pub async fn sign_hook(
        &self,
        caller: &AccountId,
        id: u64,
        hook_index: u32,
        deposit: NearToken,
    ) -> TestResult<ExecutionFinalResult> {
        self.world
            .call_contract_with_gas(
                caller,
                &self.world.oracle,
                "sign_hook",
                json!({ "assertion_id": id, "hook_index": hook_index }),
                deposit,
                NearGas::from_tgas(100),
            )
            .await
    }

    /// The Assertion view's entry for the EVM Hook at `hook_index`.
    pub async fn evm_hook(&self, id: u64, hook_index: usize) -> TestResult<Value> {
        Ok(self.world.assertion(id).await?["hooks"][hook_index]["evm"].clone())
    }

    pub async fn signed_result(&self, id: u64, hook_index: u32) -> TestResult<Value> {
        self.world
            .view(
                "get_signed_result",
                json!({ "assertion_id": id, "hook_index": hook_index }),
            )
            .await
    }
}

/// The EVM Hook the tests post: Base Sepolia, `RECEIVER` and `CONSUMER`.
pub fn evm_hook() -> Value {
    json!({ "evm": { "chain_id": CHAIN_ID, "receiver": RECEIVER, "consumer": CONSUMER } })
}

/// The EVM address of the mock signer's key.
pub fn mock_signer_address() -> String {
    let key = SigningKey::from_bytes(&MOCK_SECRET_KEY.into()).expect("valid key");
    address_of(key.verifying_key())
}

/// `0x` + the last 20 bytes of keccak256 of the uncompressed public key.
pub fn address_of(key: &VerifyingKey) -> String {
    let point = key.to_encoded_point(false);
    format!("0x{}", hex(&keccak256(&point.as_bytes()[1..])[12..]))
}

pub fn keccak256(bytes: &[u8]) -> Vec<u8> {
    Keccak256::digest(bytes).to_vec()
}

/// The address that signed `digest`, recovered the way EVM `ecrecover` does,
/// from `r`, `s` and `v` (27 or 28) given as `0x` hex.
pub fn recover(digest: &str, r: &str, s: &str, v: u8) -> String {
    let digest = unhex(digest);
    let mut rs = unhex(r);
    rs.extend(unhex(s));
    let signature = Signature::from_slice(&rs).expect("r and s form a signature");
    let recovery_id = RecoveryId::from_byte(v - 27).expect("v is 27 or 28");
    let key = VerifyingKey::recover_from_prehash(&digest, &signature, recovery_id)
        .expect("signature recovers");
    address_of(&key)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(text: &str) -> Vec<u8> {
    let digits = text.strip_prefix("0x").unwrap_or(text);
    (0..digits.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&digits[i..i + 2], 16).expect("hex"))
        .collect()
}
