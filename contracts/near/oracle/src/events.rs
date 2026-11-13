//! NEP-297 events, logged as `EVENT_JSON:{"standard":"enzure","version":"1.0.0",...}`.
use near_sdk::json_types::U64;
use near_sdk::{AccountId, Gas, NearToken, near};

use crate::ai::Verdict;
use crate::appeal::AppealReason;
use crate::evm_hooks::SignedResult;

/// An amount credited to an account's withdrawable balance.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Payout {
    pub account_id: AccountId,
    pub amount: NearToken,
}

#[near(event_json(standard = "enzure"))]
pub enum Event {
    #[event_version("1.0.0")]
    AssertionPosted {
        assertion_id: u64,
        asserter: AccountId,
        claim_hash: String,
        evidence_hash: Option<String>,
        bond: NearToken,
        liveness_ends_at_ns: U64,
    },
    #[event_version("1.0.0")]
    AssertionSettled {
        assertion_id: u64,
        outcome: bool,
        payouts: Vec<Payout>,
    },
    #[event_version("1.0.0")]
    Withdrawal {
        account_id: AccountId,
        amount: NearToken,
    },
    /// The transfer failed and the amount is back in the account's balance.
    #[event_version("1.0.0")]
    WithdrawalFailed {
        account_id: AccountId,
        amount: NearToken,
    },
    #[event_version("1.0.0")]
    ConfigChanged {
        min_bond: NearToken,
        default_liveness: u64,
        max_hooks: u32,
        max_near_hook_gas: Gas,
        appeal_window: u64,
        ai_verdict_deadline: u64,
        dao_deadline: u64,
    },
    /// The NEAR Consumer accepted `assertion_resolved`.
    #[event_version("1.0.0")]
    NearHookDelivered {
        assertion_id: u64,
        hook_index: u32,
        consumer: AccountId,
    },
    /// The NEAR Consumer's call failed; anyone can retry it with `retry_near_hook`.
    #[event_version("1.0.0")]
    NearHookFailed {
        assertion_id: u64,
        hook_index: u32,
        consumer: AccountId,
    },
    /// An EVM Hook's result message was signed; a Relayer can deliver it.
    #[event_version("1.0.0")]
    EvmHookSigned {
        assertion_id: u64,
        hook_index: u32,
        signed_result: SignedResult,
    },
    /// Signing failed, timed out (`signer_failed`) or returned an unreadable
    /// answer (`invalid_response`); the Hook can be signed again.
    #[event_version("1.0.0")]
    EvmHookSigningFailed {
        assertion_id: u64,
        hook_index: u32,
        reason: String,
    },
    #[event_version("1.0.0")]
    AssertionDisputed {
        assertion_id: u64,
        disputer: AccountId,
        evidence_hash: Option<String>,
        bond: NearToken,
        /// The seed the AI request uses.
        seed: u32,
    },
    #[event_version("1.0.0")]
    AiVerdictAccepted {
        assertion_id: u64,
        verdict: Verdict,
        /// The account that submitted it.
        resolver: AccountId,
        request_hash: String,
        response_hash: String,
        public_key: String,
        /// Null when the verdict doesn't open an Appeal Window: an
        /// UNRESOLVABLE verdict, or a second verdict.
        appeal_window_ends_at_ns: Option<U64>,
    },
    /// A second AI Verdict differed from the first; `verdicts` is `[first, second]`.
    #[event_version("1.0.0")]
    ConflictingVerdicts {
        assertion_id: u64,
        verdicts: Vec<Verdict>,
    },
    /// The Assertion went to Appeal; the DAO can rule until `dao_deadline_ns`.
    #[event_version("1.0.0")]
    AppealStarted {
        assertion_id: u64,
        reason: AppealReason,
        /// Set only when `reason` is `appealed`.
        appellant: Option<AccountId>,
        appeal_bond: Option<NearToken>,
        dao_deadline_ns: U64,
    },
    /// The DAO ruled on the Appeal; `assertion_settled` follows.
    #[event_version("1.0.0")]
    AppealResolved { assertion_id: u64, outcome: bool },
    #[event_version("1.0.0")]
    PromptTemplatePublished { version: u32, model_id: String },
    #[event_version("1.0.0")]
    RegisteredKeyAdded {
        public_key: String,
        model_id: String,
    },
    #[event_version("1.0.0")]
    RegisteredKeyRemoved {
        public_key: String,
        model_id: String,
    },
}
