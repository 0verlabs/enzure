//! NEP-297 events, logged as `EVENT_JSON:{"standard":"enzure","version":"1.0.0",...}`.
use near_sdk::json_types::U64;
use near_sdk::{AccountId, Gas, NearToken, near};

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
}
