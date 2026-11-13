//! Test-only contract. A NEAR Consumer whose `assertion_resolved` panics while
//! it is switched to failing. Otherwise it records each call's outcome and the
//! gas the call arrived with, so tests can check what the oracle delivered.
use near_sdk::json_types::U64;
use near_sdk::{env, near};

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Delivery {
    pub assertion_id: u64,
    pub truthful: bool,
    pub prepaid_gas: U64,
}

#[near(contract_state)]
#[derive(Default)]
pub struct SwitchableConsumer {
    failing: bool,
    deliveries: Vec<Delivery>,
}

#[near]
impl SwitchableConsumer {
    pub fn set_failing(&mut self, failing: bool) {
        self.failing = failing;
    }

    pub fn assertion_resolved(&mut self, assertion_id: u64, truthful: bool) {
        if self.failing {
            env::panic_str("Consumer is switched to failing");
        }
        self.deliveries.push(Delivery {
            assertion_id,
            truthful,
            prepaid_gas: U64(env::prepaid_gas().as_gas()),
        });
    }

    pub fn get_deliveries(&self) -> Vec<Delivery> {
        self.deliveries.clone()
    }
}
