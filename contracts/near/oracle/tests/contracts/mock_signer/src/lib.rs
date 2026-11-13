//! Test-only contract. Stands in for the Chain Signatures signer, because the
//! sandbox has no MPC network. It takes `sign` requests in the same shape as
//! `v1.signer-prod.testnet` and answers in that contract's response shape,
//! signed with a fixed secp256k1 key (`MOCK_SECRET_KEY`) instead of a key
//! derived from the caller and path.
//!
//! Its mode decides how it answers:
//! - `sign`: signs the payload and returns the signature;
//! - `fail`: panics, as the signer does for a rejected request;
//! - `hang`: never answers, so the request times out after 200 blocks, as a
//!   real request does when the MPC network doesn't respond.
use k256::ecdsa::SigningKey;
use near_sdk::{
    AccountId, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseOrValue, env, near,
    require,
};

/// The mock's signing key. Tests derive the expected EVM address from it.
pub const MOCK_SECRET_KEY: [u8; 32] = [0x11; 32];

#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
    Sign,
    Fail,
    Hang,
}

/// `payload_v2` in the signer's request.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub enum Payload {
    Ecdsa(String),
    Eddsa(String),
}

/// The `request` argument of the signer's `sign`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SignRequestArgs {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u64,
}

/// A request as the mock received it, for tests to inspect.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct ReceivedRequest {
    pub predecessor: AccountId,
    pub deposit: NearToken,
    pub request: SignRequestArgs,
}

#[near(serializers = [json])]
pub struct AffinePoint {
    pub affine_point: String,
}

#[near(serializers = [json])]
pub struct Scalar {
    pub scalar: String,
}

/// The signer's response for domain 0, tagged by `scheme` as the real contract
/// serialises it: `{"scheme":"Secp256k1","big_r":{"affine_point":"02.."},"s":{"scalar":".."},"recovery_id":0}`.
#[near(serializers = [json])]
#[serde(tag = "scheme")]
pub enum SignatureResponse {
    Secp256k1 {
        big_r: AffinePoint,
        s: Scalar,
        recovery_id: u8,
    },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockSigner {
    mode: Mode,
    requests: Vec<ReceivedRequest>,
}

#[near]
impl MockSigner {
    #[init]
    pub fn new() -> Self {
        Self {
            mode: Mode::Sign,
            requests: Vec::new(),
        }
    }

    pub fn set_mode(&mut self, mode: Mode) {
        self.mode = mode;
    }

    /// Same entry point and checks as the real signer: a deposit of at least one
    /// yoctoNEAR and a 32-byte ECDSA payload for domain 0.
    #[payable]
    pub fn sign(&mut self, request: SignRequestArgs) -> PromiseOrValue<SignatureResponse> {
        require!(
            env::attached_deposit() >= NearToken::from_yoctonear(1),
            "Attach at least 1 yoctoNEAR"
        );
        require!(
            env::prepaid_gas() >= Gas::from_tgas(15),
            "Attach at least 15 Tgas"
        );
        require!(request.domain_id == 0, "Only domain 0 is supported");
        let Payload::Ecdsa(payload_hex) = &request.payload_v2 else {
            env::panic_str("Payload is not Ecdsa")
        };
        let payload = decode_hex::<32>(payload_hex).expect("Ecdsa payload must be 32 bytes of hex");
        self.requests.push(ReceivedRequest {
            predecessor: env::predecessor_account_id(),
            deposit: env::attached_deposit(),
            request,
        });

        match self.mode {
            Mode::Sign => PromiseOrValue::Value(sign_payload(&payload)),
            Mode::Fail => env::panic_str("Mock signer is set to fail"),
            Mode::Hang => {
                // Yield and never resume: the runtime calls `on_timeout` after 200
                // blocks, which fails the request just like the real signer.
                let (promise, _) =
                    Promise::new_yield("on_timeout", b"{}", Gas::from_tgas(5), GasWeight(0));
                PromiseOrValue::Promise(promise)
            }
        }
    }

    #[private]
    pub fn on_timeout(&self) {
        env::panic_str("Signature request has timed out.")
    }

    /// Every request received, oldest first.
    pub fn requests(&self) -> &Vec<ReceivedRequest> {
        &self.requests
    }
}

fn sign_payload(payload: &[u8; 32]) -> SignatureResponse {
    let key = SigningKey::from_bytes(&MOCK_SECRET_KEY.into()).expect("valid key");
    let (signature, recovery_id) = key
        .sign_prehash_recoverable(payload)
        .expect("payload signs");
    let bytes = signature.to_bytes();
    // R's x-coordinate is r; the low bit of the recovery id is R's y parity.
    let mut big_r = vec![0x02 | (recovery_id.to_byte() & 1)];
    big_r.extend_from_slice(&bytes[..32]);
    SignatureResponse::Secp256k1 {
        big_r: AffinePoint {
            affine_point: encode_hex(&big_r),
        },
        s: Scalar {
            scalar: encode_hex(&bytes[32..]),
        },
        recovery_id: recovery_id.to_byte(),
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode_hex<const N: usize>(hex: &str) -> Option<[u8; N]> {
    if hex.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}
