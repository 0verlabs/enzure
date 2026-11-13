//! Enzure oracle: Assertions are posted with a NEAR bond and settle TRUE after
//! Liveness unless disputed. Vocabulary follows `GLOSSARY.md` at the repo root.
use near_sdk::json_types::U64;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, env, near, require,
};

mod ai;
mod appeal;
mod dispute;
mod events;
mod evm_hooks;
mod hash;
mod hooks;
mod registry;

pub use ai::{PromptTemplate, Verdict};
pub use appeal::{AppealReason, AppealView};
pub use dispute::{AiVerdictView, DisputeView};
pub use events::{Event, Payout};
pub use evm_hooks::{
    DEFAULT_EVM_SIGNER, EVM_DERIVATION_PATH, EVM_SIGNER_DOMAIN_ID, EvmHook, EvmHookStatus,
    EvmSignerView, RESULT_MESSAGE_VERSION, ResultMessage, SignedResult,
};
use hooks::StoredHook;
pub use hooks::{Hook, HookView, NearHook, NearHookStatus};
pub use registry::RegisteredKeyView;

pub(crate) const NS_PER_SEC: u64 = 1_000_000_000;
/// Shortest Liveness an Asserter can choose, in seconds.
pub const MIN_LIVENESS_SECS: u64 = 60;
/// Longest Liveness an Asserter can choose, in seconds.
pub const MAX_LIVENESS_SECS: u64 = 7 * 24 * 60 * 60;
const DEFAULT_LIVENESS_SECS: u64 = 2 * 60 * 60;
const DEFAULT_APPEAL_WINDOW_SECS: u64 = 24 * 60 * 60;
const DEFAULT_AI_VERDICT_DEADLINE_SECS: u64 = 60 * 60;
const DEFAULT_DAO_DEADLINE_SECS: u64 = 7 * 24 * 60 * 60;
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
    PromptTemplates,
    RegisteredKeys,
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
    /// How long, in seconds, the Appeal Window stays open after an AI Verdict.
    pub appeal_window: u64,
    /// How long, in seconds, a disputed Assertion waits for an AI Verdict
    /// before `check_timeout` can send it to Appeal.
    pub ai_verdict_deadline: u64,
    /// How long, in seconds, the DAO has to rule on an Appeal before `settle`
    /// settles it without the DAO.
    pub dao_deadline: u64,
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
    pub appeal_window: u64,
    pub ai_verdict_deadline: u64,
    pub dao_deadline: u64,
}

#[near(serializers = [borsh])]
enum AssertionState {
    Asserted,
    /// Disputed during Liveness; waiting for an AI Verdict.
    Disputed,
    /// An AI Verdict of TRUE or FALSE was accepted; it becomes the outcome once
    /// the Appeal Window closes.
    Ruled {
        outcome: bool,
    },
    /// Waiting for the DAO's ruling; the dispute's `appeal` says why.
    InAppeal,
    Settled {
        outcome: bool,
        settled_at_ns: u64,
    },
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
    /// The Prompt Template version current when the Assertion was posted.
    prompt_template_version: Option<u32>,
    dispute: Option<dispute::Dispute>,
    /// Accepted AI Verdicts, oldest first.
    ai_verdicts: Vec<dispute::AcceptedVerdict>,
}

/// Where an Assertion is in its lifecycle.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum State {
    /// Posted; it settles TRUE once Liveness ends.
    Asserted,
    /// Disputed; waiting for an AI Verdict.
    Disputed,
    /// Has an AI Verdict; it settles with it once the Appeal Window closes.
    Ruled,
    /// Waiting for the DAO's ruling, or for `settle` after the DAO deadline.
    InAppeal,
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
    /// The Prompt Template version an AI Verdict must use; null if none was
    /// published when the Assertion was posted.
    pub prompt_template_version: Option<u32>,
    pub dispute: Option<DisputeView>,
    /// Accepted AI Verdicts, oldest first.
    pub ai_verdicts: Vec<AiVerdictView>,
    /// When the Appeal Window closes; set once a TRUE or FALSE AI Verdict is
    /// accepted.
    pub appeal_window_ends_at_ns: Option<U64>,
    /// Set once the Assertion goes to Appeal.
    pub appeal: Option<AppealView>,
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
    /// The Chain Signatures signer that signs EVM Hooks.
    evm_signer: AccountId,
    /// Prompt Template versions; version `n` is at index `n - 1`.
    prompt_templates: Vector<PromptTemplate>,
    /// Registered Keys: ed25519 public keys and the model id each signs for.
    registered_keys: IterableMap<[u8; 32], String>,
}

#[near]
impl Oracle {
    /// Initialises the oracle with the DAO that is its treasury and the only
    /// account allowed to change the config. `evm_signer` is the Chain
    /// Signatures signer for EVM Hooks, `v1.signer-prod.testnet` by default
    /// (`v1.signer` on mainnet).
    #[init]
    pub fn new(dao: AccountId, evm_signer: Option<AccountId>) -> Self {
        Self {
            dao,
            config: Config {
                min_bond: DEFAULT_MIN_BOND,
                default_liveness: DEFAULT_LIVENESS_SECS,
                max_hooks: hooks::DEFAULT_MAX_HOOKS,
                max_near_hook_gas: hooks::DEFAULT_MAX_NEAR_HOOK_GAS,
                appeal_window: DEFAULT_APPEAL_WINDOW_SECS,
                ai_verdict_deadline: DEFAULT_AI_VERDICT_DEADLINE_SECS,
                dao_deadline: DEFAULT_DAO_DEADLINE_SECS,
            },
            assertions: LookupMap::new(StorageKey::Assertions),
            last_assertion_id: 0,
            balances: LookupMap::new(StorageKey::Balances),
            evm_signer: evm_signer
                .unwrap_or_else(|| DEFAULT_EVM_SIGNER.parse().expect("valid account id")),
            prompt_templates: Vector::new(StorageKey::PromptTemplates),
            registered_keys: IterableMap::new(StorageKey::RegisteredKeys),
        }
    }

    /// Posts an Assertion and returns its id.
    ///
    /// `claim_hash` and `evidence_hash` are sha256 hashes in hex of content kept
    /// off-chain. `liveness` is in seconds, from 1 minute to 7 days, and defaults
    /// to the config. `hooks` name the Consumers to tell once it settles, up to
    /// the config's `max_hooks`; their destinations can't change afterwards.
    /// Attach `bond` plus
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
            prompt_template_version: self.current_prompt_template_version(),
            dispute: None,
            ai_verdicts: Vec::new(),
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

    /// Settles an Assertion. Anyone can call it, attaching enough gas to deliver
    /// every NEAR Hook with its fixed gas. Returns the outcome.
    ///
    /// Undisputed, it settles TRUE once Liveness has ended and the whole bond is
    /// credited to the Asserter. With an AI Verdict, it settles with that verdict
    /// once the Appeal Window has closed: the winner gets their bond back plus
    /// half the loser's, and the DAO gets the other half. In Appeal, it settles
    /// once the DAO deadline has passed without a ruling: by the AI Verdict if
    /// the loser appealed it, returning the appeal bond in full; otherwise
    /// FALSE, returning every bond in full. Either way, NEAR Hooks are called
    /// after the balances are credited.
    pub fn settle(&mut self, assertion_id: u64) -> bool {
        let now = env::block_timestamp();
        let assertion = self.assertion(assertion_id);
        let (outcome, payouts) = match assertion.state {
            AssertionState::Asserted => {
                // `dispute` is allowed only while `now < liveness_ends_at_ns`, so
                // no block allows both.
                require!(
                    now >= assertion.liveness_ends_at_ns,
                    "Liveness has not ended"
                );
                let payout = Payout {
                    account_id: assertion.asserter.clone(),
                    amount: assertion.bond,
                };
                (true, vec![payout])
            }
            AssertionState::Disputed => {
                env::panic_str("Assertion is disputed and has no AI Verdict")
            }
            AssertionState::Ruled { outcome } => {
                require!(
                    now >= assertion.appeal_window_ends_at_ns().unwrap_or(u64::MAX),
                    "Appeal Window has not ended"
                );
                (
                    outcome,
                    appeal::ruled_payouts(assertion, outcome, &self.dao),
                )
            }
            AssertionState::InAppeal => appeal::overdue_settlement(assertion, now, &self.dao),
            AssertionState::Settled { .. } => env::panic_str("Assertion is already settled"),
        };
        self.complete_settlement(assertion_id, outcome, payouts, now);
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
        require_liveness_in_range("appeal_window", config.appeal_window);
        require_liveness_in_range("ai_verdict_deadline", config.ai_verdict_deadline);
        require_liveness_in_range("dao_deadline", config.dao_deadline);
        Event::ConfigChanged {
            min_bond: config.min_bond,
            default_liveness: config.default_liveness,
            max_hooks: config.max_hooks,
            max_near_hook_gas: config.max_near_hook_gas,
            appeal_window: config.appeal_window,
            ai_verdict_deadline: config.ai_verdict_deadline,
            dao_deadline: config.dao_deadline,
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
            AssertionState::Settled { outcome, .. } => Some(outcome),
            _ => None,
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
            appeal_window: self.config.appeal_window,
            ai_verdict_deadline: self.config.ai_verdict_deadline,
            dao_deadline: self.config.dao_deadline,
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

    /// Settles the Assertion with `outcome`: credits `payouts`, starts the NEAR
    /// Hooks and emits `assertion_settled`. Panics, changing nothing, if the
    /// attached gas can't deliver the NEAR Hooks.
    fn complete_settlement(
        &mut self,
        assertion_id: u64,
        outcome: bool,
        payouts: Vec<Payout>,
        now: u64,
    ) {
        let assertion = self.assertion_mut(assertion_id);
        hooks::require_gas_to_deliver(&assertion.hooks);
        assertion.state = AssertionState::Settled {
            outcome,
            settled_at_ns: now,
        };
        // The Consumer calls run in later receipts, after this one has committed
        // the settlement and the credits below.
        hooks::deliver_all(assertion_id, outcome, &mut assertion.hooks);
        for payout in &payouts {
            self.credit(&payout.account_id, payout.amount);
        }
        Event::AssertionSettled {
            assertion_id,
            outcome,
            payouts,
        }
        .emit();
    }

    fn assertion_mut(&mut self, id: u64) -> &mut Assertion {
        self.assertions
            .get_mut(&id)
            .unwrap_or_else(|| env::panic_str(&format!("Assertion {id} not found")))
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
            AssertionState::Disputed => (State::Disputed, None, None),
            AssertionState::Ruled { .. } => (State::Ruled, None, None),
            AssertionState::InAppeal => (State::InAppeal, None, None),
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
            prompt_template_version: self.prompt_template_version,
            dispute: self.dispute.as_ref().map(dispute::Dispute::view),
            ai_verdicts: self
                .ai_verdicts
                .iter()
                .map(dispute::AcceptedVerdict::view)
                .collect(),
            appeal_window_ends_at_ns: self.appeal_window_ends_at_ns().map(U64),
            appeal: self.appeal_view(),
        }
    }
}

fn require_liveness_in_range(field: &str, secs: u64) {
    require!(
        (MIN_LIVENESS_SECS..=MAX_LIVENESS_SECS).contains(&secs),
        format!("{field} must be between {MIN_LIVENESS_SECS} and {MAX_LIVENESS_SECS} seconds")
    );
}
