//! Placeholder for the Enzure oracle contract. Later tickets replace it with the real contract.
use near_sdk::near;

#[near(contract_state)]
#[derive(Default)]
pub struct Oracle {}

#[near]
impl Oracle {
    /// Returns the crate version the contract was built from.
    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}
