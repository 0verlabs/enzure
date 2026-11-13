//! Example NEAR Consumer for the Enzure oracle.
//!
//! Post an Assertion with a NEAR Hook naming this contract:
//! `"hooks": [{ "near": { "consumer": "<this account>", "gas": "20000000000000" } }]`.
//! When the Assertion settles, the oracle calls `assertion_resolved` with the
//! Assertion id and outcome. This contract accepts the call only from the oracle
//! it was initialised with, and records each Assertion's outcome once: a repeated
//! call for the same id changes nothing.
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, BorshStorageKey, PanicOnDefault, env, near, require};

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Outcomes,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct NearConsumer {
    oracle: AccountId,
    outcomes: LookupMap<u64, bool>,
}

#[near]
impl NearConsumer {
    #[init]
    pub fn new(oracle: AccountId) -> Self {
        Self {
            oracle,
            outcomes: LookupMap::new(StorageKey::Outcomes),
        }
    }

    /// Called by the oracle's NEAR Hook when an Assertion settles.
    pub fn assertion_resolved(&mut self, assertion_id: u64, truthful: bool) {
        require!(
            env::predecessor_account_id() == self.oracle,
            "Only the oracle can report outcomes"
        );
        if self.outcomes.contains_key(&assertion_id) {
            env::log_str(&format!(
                "Assertion {assertion_id} already recorded; ignored"
            ));
            return;
        }
        self.outcomes.insert(assertion_id, truthful);
        // Act on the outcome here: release an escrow, resolve a market, ...
    }

    /// The outcome recorded for an Assertion, or null if none has arrived.
    pub fn get_outcome(&self, assertion_id: u64) -> Option<bool> {
        self.outcomes.get(&assertion_id).copied()
    }

    pub fn get_oracle(&self) -> AccountId {
        self.oracle.clone()
    }
}
