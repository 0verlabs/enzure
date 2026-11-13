//! Upgrading the oracle's code (ADR 0004). After the first deploy the oracle
//! account has no full-access keys, so a DAO proposal calling `upgrade` is the
//! only way to change its code.
use near_sdk::{Gas, NearToken, Promise, env, near, require};

use crate::events::Event;
use crate::{Oracle, OracleExt, hash};

/// Gas for the new code's `migrate`, which runs in the same receipt as the deploy.
const GAS_FOR_MIGRATE: Gas = Gas::from_tgas(20);

#[near(serializers = [json])]
struct MigrateArgs {
    code_hash: String,
}

#[near]
impl Oracle {
    /// Deploys new code to the oracle account, then calls the new code's
    /// `migrate`. Both run in one receipt, so if `migrate` fails (or the code
    /// can't run) the deploy is undone and the old code stays.
    ///
    /// Pass the Wasm as the call's raw input, not as JSON. In a Sputnik DAO
    /// `FunctionCall` proposal that is the action's `args`: the base64 of the
    /// Wasm file. Only the DAO can call it, attaching one yoctoNEAR. Attach at
    /// least 100 TGas.
    #[payable]
    pub fn upgrade(&mut self) -> Promise {
        self.require_dao("Only the DAO can upgrade the contract");
        let code = env::input().unwrap_or_default();
        require!(!code.is_empty(), "Pass the new code as the call's input");
        let args = MigrateArgs {
            code_hash: hash::to_hex(&hash::sha256(&code)),
        };
        let args = near_sdk::serde_json::to_vec(&args).unwrap_or_else(|_| env::abort());
        Promise::new(env::current_account_id())
            .deploy_contract(code)
            .function_call(
                "migrate",
                args,
                NearToken::from_yoctonear(0),
                GAS_FOR_MIGRATE,
            )
    }

    /// Runs in the new code right after `upgrade` deployed it: reads the state
    /// the previous code left and emits `contract_upgraded`. A version that
    /// changes the state layout converts the old state here.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(code_hash: String) -> Self {
        let oracle: Self =
            env::state_read().unwrap_or_else(|| env::panic_str("There is no state to migrate"));
        Event::ContractUpgraded { code_hash }.emit();
        oracle
    }
}
