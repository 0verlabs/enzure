//! Hooks deliver a settled Assertion's outcome to Consumers. A NEAR Hook calls
//! `assertion_resolved(assertion_id, truthful)` on a NEAR Consumer with the gas
//! the Asserter fixed when posting. Settlement commits before the call, so a
//! failing Consumer never blocks or undoes it, and anyone can retry the Hook.
//! `settle` needs the gas for every NEAR Hook; the DAO's `resolve_appeal`, whose
//! gas a Sputnik proposal fixes, starts the ones its gas allows and leaves the
//! rest for anyone to deliver with `retry_near_hook`.
//! An EVM Hook is signed for an EVM chain's Receiver with `sign_hook`; see
//! `evm_hooks.rs`.
use near_sdk::serde_json::json;
use near_sdk::{AccountId, Gas, GasWeight, NearToken, Promise, PromiseError, env, near, require};

use crate::events::Event;
use crate::evm_hooks::{EvmHook, EvmHookStatus, StoredEvmHook};
use crate::{AssertionState, Config, Oracle, OracleExt};

/// Default for the most Hooks, NEAR and EVM together, one Assertion can have.
pub const DEFAULT_MAX_HOOKS: u32 = 4;
/// Default for the most gas an Asserter can fix for one NEAR Hook.
pub const DEFAULT_MAX_NEAR_HOOK_GAS: Gas = Gas::from_tgas(50);
/// Bytes charged to the Asserter for each Hook on top of the Assertion. Covers a
/// NEAR Hook with the longest account id, and is meant to cover an EVM Hook with
/// its stored signature.
pub const HOOK_STORAGE_BYTES: u64 = 200;
/// Gas for `on_near_hook`, the private callback that records a delivery.
const GAS_FOR_ON_NEAR_HOOK: Gas = Gas::from_tgas(10);
/// Gas a NEAR Hook costs the caller on top of its own gas: the callback plus
/// scheduling both receipts.
const GAS_PER_NEAR_HOOK: Gas = Gas::from_tgas(15);
/// Gas for the rest of `settle` or `retry_near_hook` when NEAR Hooks are due.
const GAS_FOR_HOOK_CALLER: Gas = Gas::from_tgas(20);
/// Gas `resolve_appeal` keeps for itself after starting the NEAR Hooks it can.
const GAS_TO_FINISH: Gas = Gas::from_tgas(10);
/// The most gas `settle` can need to deliver every NEAR Hook of an Assertion:
/// a transaction carries at most 300 TGas, less a 20 TGas margin. `set_config`
/// keeps `max_hooks` and `max_near_hook_gas` within it, so every Assertion can
/// be settled, and every single NEAR Hook delivered, in one transaction.
pub const MAX_GAS_TO_SETTLE: Gas = Gas::from_tgas(280);
/// The method a NEAR Consumer implements.
const CONSUMER_METHOD: &str = "assertion_resolved";

/// A Hook as `assert_claim` takes it, tagged by chain:
/// `{ "near": { "consumer": "app.near", "gas": "30000000000000" } }` or
/// `{ "evm": { "chain_id": 84532, "receiver": "0x..", "consumer": "0x.." } }`.
#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Debug, PartialEq)]
pub enum Hook {
    Near(NearHook),
    Evm(EvmHook),
}

/// Calls `assertion_resolved` on `consumer` with exactly `gas` once the
/// Assertion settles.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct NearHook {
    pub consumer: AccountId,
    pub gas: Gas,
}

/// Where a NEAR Hook's delivery stands.
#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NearHookStatus {
    /// Not started: the Assertion hasn't settled yet, or the DAO's ruling
    /// settled it without the gas to start this Hook. Once settled, anyone can
    /// deliver it with `retry_near_hook`.
    Pending,
    /// The call to the Consumer is in flight.
    Delivering,
    Delivered,
    /// The Consumer's call failed; anyone can retry it with `retry_near_hook`.
    Failed,
}

/// A Hook as the Assertion view shows it, tagged like `Hook`.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
pub enum HookView {
    Near {
        consumer: AccountId,
        gas: Gas,
        status: NearHookStatus,
    },
    /// Addresses are `0x` lowercase hex. The signed result is read with
    /// `get_signed_result`.
    Evm {
        chain_id: u64,
        receiver: String,
        consumer: String,
        status: EvmHookStatus,
    },
}

/// A Hook as the oracle stores it, with its delivery state.
#[near(serializers = [borsh])]
pub(crate) enum StoredHook {
    Near {
        hook: NearHook,
        status: NearHookStatus,
    },
    Evm(StoredEvmHook),
}

impl StoredHook {
    pub(crate) fn new(hook: Hook) -> Self {
        match hook {
            Hook::Near(hook) => Self::Near {
                hook,
                status: NearHookStatus::Pending,
            },
            Hook::Evm(hook) => Self::Evm(hook.to_stored("hooks[].evm")),
        }
    }

    pub(crate) fn view(&self) -> HookView {
        match self {
            Self::Near { hook, status } => HookView::Near {
                consumer: hook.consumer.clone(),
                gas: hook.gas,
                status: *status,
            },
            Self::Evm(hook) => hook.view(),
        }
    }
}

/// Panics unless the Hooks fit the config's limits.
pub(crate) fn validate(hooks: &[Hook], config: &Config) {
    require!(
        hooks.len() <= config.max_hooks as usize,
        format!("At most {} Hooks per Assertion", config.max_hooks)
    );
    for (index, hook) in hooks.iter().enumerate() {
        match hook {
            Hook::Near(near) => require!(
                !near.gas.is_zero() && near.gas <= config.max_near_hook_gas,
                format!(
                    "NEAR Hook gas must be between 1 and {} gas",
                    config.max_near_hook_gas.as_gas()
                )
            ),
            Hook::Evm(evm) => {
                evm.to_stored(&format!("hooks[{index}].evm"));
            }
        }
    }
}

/// Panics unless `max_hooks` NEAR Hooks of `max_near_hook_gas` each can be
/// delivered by one `settle` within `MAX_GAS_TO_SETTLE`.
pub(crate) fn validate_limits(config: &Config) {
    if config.max_hooks == 0 {
        return;
    }
    let required = config
        .max_near_hook_gas
        .saturating_add(GAS_PER_NEAR_HOOK)
        .saturating_mul(u64::from(config.max_hooks))
        .saturating_add(GAS_FOR_HOOK_CALLER);
    require!(
        required <= MAX_GAS_TO_SETTLE,
        format!(
            "max_hooks NEAR Hooks of max_near_hook_gas each must fit in {} gas to settle, \
             counting {} gas per Hook and {} for the call; these need {}",
            MAX_GAS_TO_SETTLE.as_gas(),
            GAS_PER_NEAR_HOOK.as_gas(),
            GAS_FOR_HOOK_CALLER.as_gas(),
            required.as_gas()
        )
    );
}

/// The storage deposit for an Assertion's Hooks.
pub(crate) fn storage_bytes(hooks: u32) -> u64 {
    HOOK_STORAGE_BYTES * u64::from(hooks)
}

/// Panics unless the call has enough gas to deliver every NEAR Hook in `hooks`.
fn require_gas_for<'a>(hooks: impl Iterator<Item = &'a NearHook>) {
    let mut required = Gas::from_gas(0);
    for hook in hooks {
        required = required
            .saturating_add(hook.gas)
            .saturating_add(GAS_PER_NEAR_HOOK);
    }
    if required.is_zero() {
        return;
    }
    let required = required.saturating_add(GAS_FOR_HOOK_CALLER);
    require!(
        env::prepaid_gas() >= required,
        format!(
            "Attach at least {} gas to deliver the NEAR Hooks",
            required.as_gas()
        )
    );
}

/// Panics unless the call has enough gas to deliver every NEAR Hook.
pub(crate) fn require_gas_to_deliver(hooks: &[StoredHook]) {
    require_gas_for(hooks.iter().filter_map(|hook| match hook {
        StoredHook::Near { hook, .. } => Some(hook),
        StoredHook::Evm(_) => None,
    }));
}

/// Marks every NEAR Hook as delivering and calls its Consumer. EVM Hooks wait
/// for `sign_hook`. Run `require_gas_to_deliver` first.
pub(crate) fn deliver_all(assertion_id: u64, outcome: bool, hooks: &mut [StoredHook]) {
    deliver_near_hooks(assertion_id, outcome, hooks, |_| true);
}

/// Like `deliver_all`, but only for the NEAR Hooks the call's remaining gas can
/// carry, in order, keeping `GAS_TO_FINISH` for the rest of the call. The
/// others stay pending, for anyone to deliver with `retry_near_hook`.
pub(crate) fn deliver_what_fits(assertion_id: u64, outcome: bool, hooks: &mut [StoredHook]) {
    deliver_near_hooks(assertion_id, outcome, hooks, |hook| {
        let remaining = env::prepaid_gas().saturating_sub(env::used_gas());
        remaining
            >= hook
                .gas
                .saturating_add(GAS_PER_NEAR_HOOK)
                .saturating_add(GAS_TO_FINISH)
    });
}

fn deliver_near_hooks(
    assertion_id: u64,
    outcome: bool,
    hooks: &mut [StoredHook],
    mut fits: impl FnMut(&NearHook) -> bool,
) {
    for (index, hook) in hooks.iter_mut().enumerate() {
        if let StoredHook::Near { hook, status } = hook
            && fits(hook)
        {
            *status = NearHookStatus::Delivering;
            deliver(assertion_id, index as u32, hook, outcome).detach();
        }
    }
}

/// Calls the Consumer with exactly the Hook's gas, then records the result.
fn deliver(assertion_id: u64, hook_index: u32, hook: &NearHook, outcome: bool) -> Promise {
    let args = json!({ "assertion_id": assertion_id, "truthful": outcome });
    Promise::new(hook.consumer.clone())
        .function_call_weight(
            CONSUMER_METHOD,
            args.to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            hook.gas,
            GasWeight(0),
        )
        .then(
            Oracle::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_ON_NEAR_HOOK)
                .with_unused_gas_weight(0)
                .on_near_hook(assertion_id, hook_index),
        )
}

#[near]
impl Oracle {
    /// Delivers a NEAR Hook of a settled Assertion that failed, or that the
    /// settlement had no gas to start (still pending). Anyone can call it. The
    /// transaction's result is true if the Consumer accepted the call.
    pub fn retry_near_hook(&mut self, assertion_id: u64, hook_index: u32) -> Promise {
        let assertion = self
            .assertions
            .get_mut(&assertion_id)
            .unwrap_or_else(|| env::panic_str(&format!("Assertion {assertion_id} not found")));
        let AssertionState::Settled { outcome, .. } = assertion.state else {
            env::panic_str("Assertion is not settled");
        };
        let Some(StoredHook::Near { hook, status }) = assertion.hooks.get_mut(hook_index as usize)
        else {
            env::panic_str(&format!(
                "Assertion {assertion_id} has no Hook {hook_index}"
            ));
        };
        match status {
            NearHookStatus::Pending | NearHookStatus::Failed => {}
            NearHookStatus::Delivered => env::panic_str("NEAR Hook is already delivered"),
            NearHookStatus::Delivering => env::panic_str("NEAR Hook is being delivered"),
        }
        require_gas_for(std::iter::once(&*hook));
        *status = NearHookStatus::Delivering;
        deliver(assertion_id, hook_index, hook, outcome)
    }

    /// Records a NEAR Hook's delivery. Never panics, so the result always sticks
    /// and a failed Hook stays retryable. Returns true if it was delivered.
    #[private]
    pub fn on_near_hook(&mut self, assertion_id: u64, hook_index: u32) -> bool {
        // A Consumer's return value of any size counts as success.
        let delivered = env::promise_results_count() == 1
            && !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        let Some(assertion) = self.assertions.get_mut(&assertion_id) else {
            return false;
        };
        let Some(StoredHook::Near { hook, status }) = assertion.hooks.get_mut(hook_index as usize)
        else {
            return false;
        };
        let consumer = hook.consumer.clone();
        if delivered {
            *status = NearHookStatus::Delivered;
            Event::NearHookDelivered {
                assertion_id,
                hook_index,
                consumer,
            }
            .emit();
        } else {
            *status = NearHookStatus::Failed;
            Event::NearHookFailed {
                assertion_id,
                hook_index,
                consumer,
            }
            .emit();
        }
        delivered
    }
}
