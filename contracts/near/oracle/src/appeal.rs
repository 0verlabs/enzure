//! Appeal and the DAO (ADR 0001).
//!
//! A disputed Assertion goes to Appeal when the party that lost the AI Verdict
//! appeals during the Appeal Window, when a second AI Verdict differs from the
//! first (Conflicting Verdicts), when the AI Verdict is UNRESOLVABLE, or when
//! no AI Verdict arrives before the AI Verdict deadline. The DAO then rules
//! with `resolve_appeal`; if it misses the DAO deadline, `settle` settles the
//! Assertion by itself.
use near_sdk::json_types::U64;
use near_sdk::{AccountId, NearToken, Promise, env, near, require};

use crate::ai::Verdict;
use crate::events::{Event, Payout};
use crate::{Assertion, AssertionState, NS_PER_SEC, Oracle, OracleExt};

/// Why an Assertion went to Appeal.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppealReason {
    /// The party that lost the AI Verdict appealed with a bond.
    Appealed,
    /// A second AI Verdict differed from the first during the Appeal Window.
    Conflicting,
    /// The AI Verdict was UNRESOLVABLE.
    Unresolvable,
    /// No AI Verdict arrived before the AI Verdict deadline.
    NoVerdict,
}

#[near(serializers = [borsh])]
pub(crate) struct Appeal {
    pub(crate) reason: AppealReason,
    pub(crate) started_at_ns: u64,
    pub(crate) dao_deadline_ns: u64,
}

/// An Appeal as the views return it.
#[near(serializers = [json])]
pub struct AppealView {
    pub reason: AppealReason,
    /// The party that appealed with a bond; null unless `reason` is `appealed`.
    pub appellant: Option<AccountId>,
    /// The appeal bond, equal to the Assertion's; null unless `reason` is `appealed`.
    pub appeal_bond: Option<NearToken>,
    pub started_at_ns: U64,
    /// The DAO can rule until this time; from then on `settle` settles the
    /// Assertion without it.
    pub dao_deadline_ns: U64,
}

impl Assertion {
    pub(crate) fn appeal(&self) -> Option<&Appeal> {
        self.dispute.as_ref()?.appeal.as_ref()
    }

    pub(crate) fn appeal_view(&self) -> Option<AppealView> {
        let appeal = self.appeal()?;
        let appellant = self.appellant().cloned();
        Some(AppealView {
            reason: appeal.reason,
            appeal_bond: appellant.as_ref().map(|_| self.bond),
            appellant,
            started_at_ns: U64(appeal.started_at_ns),
            dao_deadline_ns: U64(appeal.dao_deadline_ns),
        })
    }

    /// The first AI Verdict's outcome, if it was TRUE or FALSE.
    fn ai_outcome(&self) -> Option<bool> {
        match self.ai_verdicts.first()?.verdict {
            Verdict::True => Some(true),
            Verdict::False => Some(false),
            Verdict::Unresolvable => None,
        }
    }

    fn disputer(&self) -> &AccountId {
        &self
            .dispute
            .as_ref()
            .unwrap_or_else(|| env::abort())
            .disputer
    }

    /// The party an outcome goes against.
    fn loser(&self, outcome: bool) -> &AccountId {
        if outcome {
            self.disputer()
        } else {
            &self.asserter
        }
    }

    fn winner(&self, outcome: bool) -> &AccountId {
        self.loser(!outcome)
    }

    /// The party that appealed with a bond: the one that lost the AI Verdict.
    fn appellant(&self) -> Option<&AccountId> {
        match self.appeal()?.reason {
            AppealReason::Appealed => Some(self.loser(self.ai_outcome()?)),
            _ => None,
        }
    }

    /// Moves the Assertion to Appeal, starting the DAO deadline.
    pub(crate) fn start_appeal(
        &mut self,
        assertion_id: u64,
        reason: AppealReason,
        now: u64,
        dao_deadline_secs: u64,
    ) {
        let dao_deadline_ns = now + dao_deadline_secs * NS_PER_SEC;
        self.state = AssertionState::InAppeal;
        self.dispute.as_mut().unwrap_or_else(|| env::abort()).appeal = Some(Appeal {
            reason,
            started_at_ns: now,
            dao_deadline_ns,
        });
        let appellant = self.appellant().cloned();
        Event::AppealStarted {
            assertion_id,
            reason,
            appeal_bond: appellant.as_ref().map(|_| self.bond),
            appellant,
            dao_deadline_ns: U64(dao_deadline_ns),
        }
        .emit();
    }
}

#[near]
impl Oracle {
    /// Appeals an AI Verdict to the DAO. Only the party that lost the AI
    /// Verdict can call it, once, while the Appeal Window is open, attaching an
    /// appeal bond equal to the Assertion's bond; anything above that is
    /// refunded. A rejected call returns the whole deposit.
    #[payable]
    pub fn appeal(&mut self, assertion_id: u64) {
        let now = env::block_timestamp();
        let dao_deadline = self.config.dao_deadline;
        let assertion = self.assertion_mut(assertion_id);
        let outcome = match assertion.state {
            AssertionState::Ruled { outcome } => outcome,
            AssertionState::Asserted => env::panic_str("Assertion is not disputed"),
            AssertionState::Disputed => env::panic_str("Assertion has no AI Verdict to Appeal"),
            AssertionState::InAppeal => env::panic_str("Assertion is already in Appeal"),
            AssertionState::Settled { .. } => env::panic_str("Assertion is already settled"),
        };
        // `settle` is allowed from the end of the Appeal Window on, so no block
        // allows both.
        require!(
            now < assertion.appeal_window_ends_at_ns().unwrap_or(0),
            "Appeal Window has ended"
        );
        let appellant = env::predecessor_account_id();
        require!(
            &appellant == assertion.loser(outcome),
            "Only the party that lost the AI Verdict can Appeal"
        );
        let attached = env::attached_deposit();
        require!(
            attached >= assertion.bond,
            format!(
                "Attach an appeal bond equal to the Assertion's bond: {} yoctoNEAR",
                assertion.bond.as_yoctonear()
            )
        );
        let excess = attached.saturating_sub(assertion.bond);
        assertion.start_appeal(assertion_id, AppealReason::Appealed, now, dao_deadline);
        if !excess.is_zero() {
            Promise::new(appellant).transfer(excess).detach();
        }
    }

    /// Sends a disputed Assertion that got no AI Verdict before its AI Verdict
    /// deadline (`dispute.ai_verdict_deadline_ns`) to Appeal. Anyone can call it.
    pub fn check_timeout(&mut self, assertion_id: u64) {
        let now = env::block_timestamp();
        let dao_deadline = self.config.dao_deadline;
        let assertion = self.assertion_mut(assertion_id);
        match assertion.state {
            AssertionState::Disputed => {}
            AssertionState::Asserted => env::panic_str("Assertion is not disputed"),
            AssertionState::Ruled { .. } => env::panic_str("Assertion already has an AI Verdict"),
            AssertionState::InAppeal => env::panic_str("Assertion is already in Appeal"),
            AssertionState::Settled { .. } => env::panic_str("Assertion is already settled"),
        }
        let deadline = assertion
            .dispute
            .as_ref()
            .unwrap_or_else(|| env::abort())
            .ai_verdict_deadline_ns;
        require!(now >= deadline, "AI Verdict deadline has not passed");
        assertion.start_appeal(assertion_id, AppealReason::NoVerdict, now, dao_deadline);
    }

    /// The DAO's ruling on an Assertion in Appeal, which settles it at once.
    /// Only the DAO can call it, attaching one yoctoNEAR, until the DAO
    /// deadline. Returns the outcome.
    ///
    /// The NEAR Hooks start as far as the call's gas allows (a Sputnik
    /// proposal fixes it); the ruling never fails for lack of Hook gas, and
    /// anyone delivers the Hooks left pending with `retry_near_hook`.
    ///
    /// The winner gets their bond back plus half the loser's, and the DAO the
    /// other half. An appellant who wins gets the appeal bond back; one who
    /// loses forfeits half of it to the other party and half to the DAO.
    #[payable]
    pub fn resolve_appeal(&mut self, assertion_id: u64, truthful: bool) -> bool {
        near_sdk::assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.dao,
            "Only the DAO can resolve an Appeal"
        );
        let now = env::block_timestamp();
        let assertion = self.assertion(assertion_id);
        let appeal = match assertion.state {
            AssertionState::InAppeal => assertion.appeal().unwrap_or_else(|| env::abort()),
            AssertionState::Settled { .. } => env::panic_str("Assertion is already settled"),
            _ => env::panic_str("Assertion is not in Appeal"),
        };
        // `settle` is allowed from the DAO deadline on, so no block allows both.
        require!(
            now < appeal.dao_deadline_ns,
            "The DAO deadline has passed; call settle"
        );
        let payouts = dao_ruling_payouts(assertion, truthful, &self.dao);
        Event::AppealResolved {
            assertion_id,
            outcome: truthful,
        }
        .emit();
        self.complete_settlement(assertion_id, truthful, payouts, now, false);
        truthful
    }
}

/// Credits `amount` to `account_id`, merging with an earlier payout to the same
/// account so each account appears once.
fn add(payouts: &mut Vec<Payout>, account_id: &AccountId, amount: u128) {
    if amount == 0 {
        return;
    }
    match payouts.iter_mut().find(|p| &p.account_id == account_id) {
        Some(payout) => {
            payout.amount = payout
                .amount
                .saturating_add(NearToken::from_yoctonear(amount))
        }
        None => payouts.push(Payout {
            account_id: account_id.clone(),
            amount: NearToken::from_yoctonear(amount),
        }),
    }
}

/// The winner gets their bond back plus half the loser's, the DAO the other
/// half. An odd yoctoNEAR goes to the winner.
fn disputed_payouts(assertion: &Assertion, outcome: bool, dao: &AccountId) -> Vec<Payout> {
    let bond = assertion.bond.as_yoctonear();
    let dao_share = bond / 2;
    let mut payouts = Vec::new();
    add(
        &mut payouts,
        assertion.winner(outcome),
        bond + (bond - dao_share),
    );
    add(&mut payouts, dao, dao_share);
    payouts
}

/// Payouts for the DAO's ruling `outcome`.
fn dao_ruling_payouts(assertion: &Assertion, outcome: bool, dao: &AccountId) -> Vec<Payout> {
    let mut payouts = disputed_payouts(assertion, outcome, dao);
    if let Some(appellant) = assertion.appellant() {
        let bond = assertion.bond.as_yoctonear();
        if appellant == assertion.winner(outcome) {
            add(&mut payouts, appellant, bond);
        } else {
            let dao_share = bond / 2;
            add(&mut payouts, assertion.winner(outcome), bond - dao_share);
            add(&mut payouts, dao, dao_share);
        }
    }
    payouts
}

/// The outcome and payouts of an Appeal the DAO didn't rule on by its deadline.
/// With an AI Verdict and no Conflicting Verdicts, the AI Verdict stands and the
/// appeal bond is returned in full. Otherwise the outcome is FALSE and every
/// bond is returned in full.
pub(crate) fn overdue_settlement(
    assertion: &Assertion,
    now: u64,
    dao: &AccountId,
) -> (bool, Vec<Payout>) {
    let appeal = assertion.appeal().unwrap_or_else(|| env::abort());
    require!(
        now >= appeal.dao_deadline_ns,
        "Appeal is waiting for the DAO"
    );
    let bond = assertion.bond.as_yoctonear();
    match (appeal.reason, assertion.ai_outcome()) {
        (AppealReason::Appealed, Some(outcome)) => {
            let mut payouts = disputed_payouts(assertion, outcome, dao);
            add(&mut payouts, assertion.loser(outcome), bond);
            (outcome, payouts)
        }
        _ => {
            let mut payouts = Vec::new();
            add(&mut payouts, &assertion.asserter, bond);
            add(&mut payouts, assertion.disputer(), bond);
            (false, payouts)
        }
    }
}

/// Payouts for an Assertion settled with its AI Verdict after the Appeal Window.
pub(crate) fn ruled_payouts(assertion: &Assertion, outcome: bool, dao: &AccountId) -> Vec<Payout> {
    disputed_payouts(assertion, outcome, dao)
}
