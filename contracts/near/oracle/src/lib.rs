//! Enzure oracle: Assertions are posted with a NEAR bond and settle TRUE after
//! Liveness unless disputed. Vocabulary follows `GLOSSARY.md` at the repo root.
use near_sdk::json_types::U64;
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, env, near, require,
};

mod events;
mod hash;
mod hooks;

pub use events::{Event, Payout};
use hooks::StoredHook;
pub use hooks::{Hook, HookView, NearHook, NearHookStatus};

const NS_PER_SEC: u64 = 1_000_000_000;
/// Shortest Liveness an Asserter can choose, in seconds.
pub const MIN_LIVENESS_SECS: u64 = 60;
/// Longest Liveness an Asserter can choose, in seconds.
pub const MAX_LIVENESS_SECS: u64 = 7 * 24 * 60 * 60;
const DEFAULT_LIVENESS_SECS: u64 = 2 * 60 * 60;
const DEFAULT_MIN_BOND: NearToken = NearToken::from_near(1);
const DEFAULT_PAGE_SIZE: u32 = 20;
const MAX_PAGE_SIZE: u32 = 100;
const GAS_FOR_ON_WITHDRAW: Gas = Gas::from_tgas(10);

/// Bytes charged to the Asserter for each Assertion: the Assertion record with the
/// longest possible account id, plus one balance entry for its payout. The
/// sandbox tests check real usage stays under this.
const ASSERTION_STORAGE_BYTES: u64 = 500;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Assertions,
    Balances,
}

/// Settings the DAO can change.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    /// Smallest bond an Asserter may post.
    pub min_bond: NearToken,
    /// Liveness, in seconds, for Assertions posted without one.
    pub default_liveness: u64,
    /// The most Hooks, NEAR and EVM together, one Assertion can have.
    pub max_hooks: u32,
    /// The most gas an Asserter can fix for one NEAR Hook.
    pub max_near_hook_gas: Gas,
}

/// The config as the `get_config` view returns it.
#[near(serializers = [json])]
pub struct ConfigView {
    /// The DAO: the treasury, and the only account that can change the config.
    pub dao: AccountId,
    pub min_bond: NearToken,
    pub default_liveness: u64,
    pub max_hooks: u32,
    pub max_near_hook_gas: Gas,
}

#[near(serializers = [borsh])]
enum AssertionState {
    Asserted,
    Settled { outcome: bool, settled_at_ns: u64 },
}

#[near(serializers = [borsh])]
struct Assertion {
    asserter: AccountId,
    claim_hash: [u8; 32],
    evidence_hash: Option<[u8; 32]>,
    bond: NearToken,
    asserted_at_ns: u64,
    liveness_ends_at_ns: u64,
    state: AssertionState,
    /// Fixed when posting; only their delivery state changes.
    hooks: Vec<StoredHook>,
}

/// Where an Assertion is in its lifecycle.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum State {
    /// Posted; it settles TRUE once Liveness ends.
    Asserted,
    Settled,
}

/// An Assertion as the views return it. Timestamps are nanoseconds since the
/// Unix epoch, as strings.
#[near(serializers = [json])]
pub struct AssertionView {
    pub id: u64,
    pub asserter: AccountId,
    /// sha256 of the Claim, in lowercase hex.
    pub claim_hash: String,
    /// sha256 of the Asserter's Evidence, in lowercase hex.
    pub evidence_hash: Option<String>,
    pub bond: NearToken,
    pub state: State,
    pub asserted_at_ns: U64,
    /// Settlement is allowed from this time on.
    pub liveness_ends_at_ns: U64,
    pub settled_at_ns: Option<U64>,
    /// The settled outcome; null until the Assertion settles.
    pub outcome: Option<bool>,
    pub hooks: Vec<HookView>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Oracle {
    dao: AccountId,
    config: Config,
    assertions: LookupMap<u64, Assertion>,
    /// Id of the newest Assertion; ids start at 1, so 0 means none yet.
    last_assertion_id: u64,
    balances: LookupMap<AccountId, NearToken>,
}

#[near]
impl Oracle {
    /// Initialises the oracle with the DAO that is its treasury and the only
    /// account allowed to change the config.
    #[init]
    pub fn new(dao: AccountId) -> Self {
        Self {
            dao,
            config: Config {
                min_bond: DEFAULT_MIN_BOND,
                default_liveness: DEFAULT_LIVENESS_SECS,
                max_hooks: hooks::DEFAULT_MAX_HOOKS,
                max_near_hook_gas: hooks::DEFAULT_MAX_NEAR_HOOK_GAS,
            },
            assertions: LookupMap::new(StorageKey::Assertions),
            last_assertion_id: 0,
            balances: LookupMap::new(StorageKey::Balances),
        }
    }

    /// Posts an Assertion and returns its id.
    ///
    /// `claim_hash` and `evidence_hash` are sha256 hashes in hex of content kept
    /// off-chain. `liveness` is in seconds, from 1 minute to 7 days, and defaults
    /// to the config. `hooks` name the Consumers to tell once it settles, up to
    /// the config's `max_hooks`. Attach `bond` plus
    /// `assertion_storage_deposit(hooks.len())`; anything above that is refunded.
    /// A rejected call returns the whole deposit.
    #[payable]
    pub fn assert_claim(
        &mut self,
        claim_hash: String,
        evidence_hash: Option<String>,
        bond: NearToken,
        liveness: Option<u64>,
        hooks: Vec<Hook>,
    ) -> u64 {
        let claim_hash = hash::parse("claim_hash", &claim_hash);
        let evidence_hash = evidence_hash.map(|hex| hash::parse("evidence_hash", &hex));
        hooks::validate(&hooks, &self.config);
        require!(
            bond >= self.config.min_bond,
            format!(
                "Bond must be at least {} yoctoNEAR",
                self.config.min_bond.as_yoctonear()
            )
        );
        let liveness = liveness.unwrap_or(self.config.default_liveness);
        require_liveness_in_range("Liveness", liveness);
        let required = bond.saturating_add(Self::storage_deposit(hooks.len() as u32));
        let attached = env::attached_deposit();
        require!(
            attached >= required,
            format!(
                "Attach the bond plus the storage deposit: {} yoctoNEAR",
                required.as_yoctonear()
            )
        );

        let asserter = env::predecessor_account_id();
        let now = env::block_timestamp();
        let id = self.last_assertion_id + 1;
        self.last_assertion_id = id;
        let assertion = Assertion {
            asserter: asserter.clone(),
            claim_hash,
            evidence_hash,
            bond,
            asserted_at_ns: now,
            liveness_ends_at_ns: now + liveness * NS_PER_SEC,
            state: AssertionState::Asserted,
            hooks: hooks.into_iter().map(StoredHook::new).collect(),
        };
        Event::AssertionPosted {
            assertion_id: id,
            asserter: asserter.clone(),
            claim_hash: hash::to_hex(&assertion.claim_hash),
            evidence_hash: assertion.evidence_hash.as_ref().map(hash::to_hex),
            bond,
            liveness_ends_at_ns: U64(assertion.liveness_ends_at_ns),
        }
        .emit();
        self.assertions.insert(id, assertion);

        let excess = attached.saturating_sub(required);
        if !excess.is_zero() {
            Promise::new(asserter).transfer(excess).detach();
        }
        id
    }

    /// Settles an Assertion whose Liveness has ended without a dispute: it is
    /// TRUE and the whole bond is credited to the Asserter's balance. Anyone can
    /// call it, attaching enough gas to deliver every NEAR Hook with its fixed gas.
    /// NEAR Hooks are called after the balances are credited. Returns the outcome.
    pub fn settle(&mut self, assertion_id: u64) -> bool {
        let now = env::block_timestamp();
        let assertion = self
            .assertions
            .get_mut(&assertion_id)
            .unwrap_or_else(|| env::panic_str(&format!("Assertion {assertion_id} not found")));
        require!(
            matches!(assertion.state, AssertionState::Asserted),
            "Assertion is already settled"
        );
        // Disputes will be allowed while `now < liveness_ends_at_ns` and
        // settlement from then on, so no block allows both.
        require!(
            now >= assertion.liveness_ends_at_ns,
            "Liveness has not ended"
        );
        hooks::require_gas_to_deliver(&assertion.hooks);

        let outcome = true;
        assertion.state = AssertionState::Settled {
            outcome,
            settled_at_ns: now,
        };
        let payout = Payout {
            account_id: assertion.asserter.clone(),
            amount: assertion.bond,
        };
        // The Consumer calls run in later receipts, after this one has committed
        // the settlement and the credit below.
        hooks::deliver_all(assertion_id, outcome, &mut assertion.hooks);
        self.credit(&payout.account_id, payout.amount);
        Event::AssertionSettled {
            assertion_id,
            outcome,
            payouts: vec![payout],
        }
        .emit();
        outcome
    }

    /// Sends `amount` of the caller's balance to the caller, or the whole balance
    /// if `amount` is omitted. Requires exactly one yoctoNEAR, so a limited access
    /// key can't call it. If the transfer fails, the amount goes back into the
    /// balance. The transaction's result is true if the transfer succeeded.
    #[payable]
    pub fn withdraw(&mut self, amount: Option<NearToken>) -> Promise {
        near_sdk::assert_one_yocto();
        let account_id = env::predecessor_account_id();
        let balance = self.get_balance(account_id.clone());
        let amount = amount.unwrap_or(balance);
        require!(!amount.is_zero(), "Nothing to withdraw");
        require!(amount <= balance, "Amount exceeds the balance");

        // Debit before the transfer, so a second withdrawal can't spend it again.
        self.set_balance(&account_id, balance.saturating_sub(amount));
        Promise::new(account_id.clone()).transfer(amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_ON_WITHDRAW)
                .on_withdraw(account_id, amount),
        )
    }

    /// Records a withdrawal's result, re-crediting the balance if the transfer
    /// failed. Never panics, so the re-credit always sticks.
    #[private]
    pub fn on_withdraw(&mut self, account_id: AccountId, amount: NearToken) -> bool {
        let sent = env::promise_result_checked(0, 0).is_ok();
        if sent {
            Event::Withdrawal { account_id, amount }.emit();
        } else {
            self.credit(&account_id, amount);
            Event::WithdrawalFailed { account_id, amount }.emit();
        }
        sent
    }

    /// Replaces the config. Only the DAO can call it, attaching one yoctoNEAR.
    #[payable]
    pub fn set_config(&mut self, config: Config) {
        near_sdk::assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.dao,
            "Only the DAO can change the config"
        );
        require!(!config.min_bond.is_zero(), "min_bond must be above zero");
        require_liveness_in_range("default_liveness", config.default_liveness);
        Event::ConfigChanged {
            min_bond: config.min_bond,
            default_liveness: config.default_liveness,
            max_hooks: config.max_hooks,
            max_near_hook_gas: config.max_near_hook_gas,
        }
        .emit();
        self.config = config;
    }

    /// The deposit, on top of the bond, that `assert_claim` needs for storage of
    /// an Assertion with `hooks` Hooks (default 0).
    pub fn assertion_storage_deposit(&self, hooks: Option<u32>) -> NearToken {
        Self::storage_deposit(hooks.unwrap_or(0))
    }

    /// An Assertion with its state and timers. Panics if there is none with this id.
    pub fn get_assertion(&self, assertion_id: u64) -> AssertionView {
        self.assertion(assertion_id).view(assertion_id)
    }

    /// Assertions newest first. Pass the last id of a page as `before_id` to get
    /// the next page. `limit` defaults to 20 and is capped at 100.
    pub fn list_assertions(
        &self,
        before_id: Option<u64>,
        limit: Option<u32>,
    ) -> Vec<AssertionView> {
        let start = before_id
            .unwrap_or(u64::MAX)
            .min(self.last_assertion_id.saturating_add(1));
        let limit = limit.unwrap_or(DEFAULT_PAGE_SIZE).min(MAX_PAGE_SIZE);
        (1..start)
            .rev()
            .take(limit as usize)
            .map(|id| self.assertion(id).view(id))
            .collect()
    }

    /// The outcome of a settled Assertion, or null while it is unsettled.
    pub fn get_outcome(&self, assertion_id: u64) -> Option<bool> {
        match self.assertion(assertion_id).state {
            AssertionState::Asserted => None,
            AssertionState::Settled { outcome, .. } => Some(outcome),
        }
    }

    /// The amount `account_id` can withdraw.
    pub fn get_balance(&self, account_id: AccountId) -> NearToken {
        self.balances
            .get(&account_id)
            .copied()
            .unwrap_or(NearToken::from_yoctonear(0))
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            dao: self.dao.clone(),
            min_bond: self.config.min_bond,
            default_liveness: self.config.default_liveness,
            max_hooks: self.config.max_hooks,
            max_near_hook_gas: self.config.max_near_hook_gas,
        }
    }
}

impl Oracle {
    fn storage_deposit(hooks: u32) -> NearToken {
        let bytes = ASSERTION_STORAGE_BYTES.saturating_add(hooks::storage_bytes(hooks));
        env::storage_byte_cost().saturating_mul(bytes.into())
    }

    fn credit(&mut self, account_id: &AccountId, amount: NearToken) {
        let balance = self.get_balance(account_id.clone());
        self.set_balance(account_id, balance.saturating_add(amount));
    }

    /// Stores a balance, dropping the entry at zero to free its storage.
    fn set_balance(&mut self, account_id: &AccountId, balance: NearToken) {
        if balance.is_zero() {
            self.balances.remove(account_id);
        } else {
            self.balances.insert(account_id.clone(), balance);
        }
    }

    fn assertion(&self, id: u64) -> &Assertion {
        self.assertions
            .get(&id)
            .unwrap_or_else(|| env::panic_str(&format!("Assertion {id} not found")))
    }
}

impl Assertion {
    fn view(&self, id: u64) -> AssertionView {
        let (state, settled_at_ns, outcome) = match self.state {
            AssertionState::Asserted => (State::Asserted, None, None),
            AssertionState::Settled {
                outcome,
                settled_at_ns,
            } => (State::Settled, Some(U64(settled_at_ns)), Some(outcome)),
        };
        AssertionView {
            id,
            asserter: self.asserter.clone(),
            claim_hash: hash::to_hex(&self.claim_hash),
            evidence_hash: self.evidence_hash.as_ref().map(hash::to_hex),
            bond: self.bond,
            state,
            asserted_at_ns: U64(self.asserted_at_ns),
            liveness_ends_at_ns: U64(self.liveness_ends_at_ns),
            settled_at_ns,
            outcome,
            hooks: self.hooks.iter().map(StoredHook::view).collect(),
        }
    }
}

fn require_liveness_in_range(field: &str, secs: u64) {
    require!(
        (MIN_LIVENESS_SECS..=MAX_LIVENESS_SECS).contains(&secs),
        format!("{field} must be between {MIN_LIVENESS_SECS} and {MAX_LIVENESS_SECS} seconds")
    );
}
