//! Test-only contract. Deployed on an Asserter's account, it calls the oracle's
//! `withdraw` and deletes the account in the same block, so the oracle's transfer
//! arrives at an account that no longer exists and fails.
use near_sdk::{AccountId, Gas, NearToken, Promise, env, near};

#[near(contract_state)]
#[derive(Default)]
pub struct SelfDeletingAccount {}

#[near]
impl SelfDeletingAccount {
    pub fn withdraw_and_delete(&mut self, oracle: AccountId, beneficiary: AccountId) {
        Promise::new(oracle)
            .function_call(
                "withdraw".to_string(),
                b"{}".to_vec(),
                NearToken::from_yoctonear(1),
                Gas::from_tgas(50),
            )
            .detach();
        Promise::new(env::current_account_id())
            .delete_account(beneficiary)
            .detach();
    }
}
