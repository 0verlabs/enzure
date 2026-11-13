//! Disputes and AI Verdicts (ADR 0001, ADR 0003).
//!
//! A Disputer matches the Asserter's bond during Liveness. Anyone can then
//! submit an AI Verdict: the contract rebuilds the request from the pinned
//! Prompt Template, the seed chosen at dispute time and the Claim and Evidence,
//! and accepts the verdict only if a Registered Key for the pinned model signed
//! `model_id:sha256(request):sha256(response)`.
use near_sdk::json_types::U64;
use near_sdk::{AccountId, NearToken, Promise, env, near, require};

use crate::ai::{self, Content, PromptTemplate, Verdict};
use crate::appeal::{Appeal, AppealReason};
use crate::events::Event;
use crate::{Assertion, AssertionState, NS_PER_SEC, Oracle, OracleExt, hash};

/// Bytes charged to the Disputer: the dispute record with the longest possible
/// account id, one accepted AI Verdict, and balance entries for the Disputer
/// and the DAO. The sandbox tests check real usage stays under this.
const DISPUTE_STORAGE_BYTES: u64 = 500;

#[near(serializers = [borsh])]
pub(crate) struct Dispute {
    pub(crate) disputer: AccountId,
    evidence_hash: Option<[u8; 32]>,
    seed: u32,
    disputed_at_ns: u64,
    /// From this time on, with no AI Verdict, `check_timeout` sends the
    /// Assertion to Appeal.
    pub(crate) ai_verdict_deadline_ns: u64,
    appeal_window_ends_at_ns: Option<u64>,
    pub(crate) appeal: Option<Appeal>,
}

#[near(serializers = [borsh])]
pub(crate) struct AcceptedVerdict {
    pub(crate) verdict: Verdict,
    request_hash: [u8; 32],
    response_hash: [u8; 32],
    public_key: [u8; 32],
    accepted_at_ns: u64,
}

/// A dispute as the views return it.
#[near(serializers = [json])]
pub struct DisputeView {
    pub disputer: AccountId,
    /// sha256 of the Disputer's Evidence, in lowercase hex.
    pub evidence_hash: Option<String>,
    /// The seed the AI request uses, taken from the block's random seed.
    pub seed: u32,
    pub disputed_at_ns: U64,
    /// With no AI Verdict by this time, anyone can call `check_timeout` to send
    /// the Assertion to Appeal.
    pub ai_verdict_deadline_ns: U64,
}

/// An accepted AI Verdict as the views return it.
#[near(serializers = [json])]
pub struct AiVerdictView {
    pub verdict: Verdict,
    /// sha256 of the request and response bytes, in lowercase hex.
    pub request_hash: String,
    pub response_hash: String,
    /// The Registered Key that signed it, in hex.
    pub public_key: String,
    pub accepted_at_ns: U64,
}

impl Dispute {
    pub(crate) fn view(&self) -> DisputeView {
        DisputeView {
            disputer: self.disputer.clone(),
            evidence_hash: self.evidence_hash.as_ref().map(hash::to_hex),
            seed: self.seed,
            disputed_at_ns: U64(self.disputed_at_ns),
            ai_verdict_deadline_ns: U64(self.ai_verdict_deadline_ns),
        }
    }
}

impl AcceptedVerdict {
    pub(crate) fn view(&self) -> AiVerdictView {
        AiVerdictView {
            verdict: self.verdict,
            request_hash: hash::to_hex(&self.request_hash),
            response_hash: hash::to_hex(&self.response_hash),
            public_key: hash::to_hex(&self.public_key),
            accepted_at_ns: U64(self.accepted_at_ns),
        }
    }
}

impl Assertion {
    pub(crate) fn appeal_window_ends_at_ns(&self) -> Option<u64> {
        self.dispute.as_ref()?.appeal_window_ends_at_ns
    }
}

#[near]
impl Oracle {
    /// Disputes an Assertion during its Liveness. Attach a bond equal to the
    /// Assertion's plus `dispute_storage_deposit()`; anything above that is
    /// refunded. `evidence_hash` is the sha256 in hex of the Disputer's
    /// Evidence. A rejected call returns the whole deposit.
    #[payable]
    pub fn dispute(&mut self, assertion_id: u64, evidence_hash: Option<String>) {
        let evidence_hash = evidence_hash.map(|hex| hash::parse("evidence_hash", &hex));
        let now = env::block_timestamp();
        let storage = Self::dispute_storage();
        let ai_verdict_deadline = self.config.ai_verdict_deadline;
        let assertion = self
            .assertions
            .get_mut(&assertion_id)
            .unwrap_or_else(|| env::panic_str(&format!("Assertion {assertion_id} not found")));
        match assertion.state {
            AssertionState::Asserted => {}
            AssertionState::Settled { .. } => env::panic_str("Assertion is already settled"),
            _ => env::panic_str("Assertion is already disputed"),
        }
        // `settle` is allowed from `liveness_ends_at_ns` on, so no block allows both.
        require!(now < assertion.liveness_ends_at_ns, "Liveness has ended");
        let required = assertion.bond.saturating_add(storage);
        let attached = env::attached_deposit();
        require!(
            attached >= required,
            format!(
                "Attach the Assertion's bond plus the storage deposit: {} yoctoNEAR",
                required.as_yoctonear()
            )
        );

        let disputer = env::predecessor_account_id();
        let seed = dispute_seed();
        assertion.state = AssertionState::Disputed;
        assertion.dispute = Some(Dispute {
            disputer: disputer.clone(),
            evidence_hash,
            seed,
            disputed_at_ns: now,
            ai_verdict_deadline_ns: now + ai_verdict_deadline * NS_PER_SEC,
            appeal_window_ends_at_ns: None,
            appeal: None,
        });
        Event::AssertionDisputed {
            assertion_id,
            disputer: disputer.clone(),
            evidence_hash: evidence_hash.as_ref().map(hash::to_hex),
            bond: assertion.bond,
            seed,
        }
        .emit();

        let excess = attached.saturating_sub(required);
        if !excess.is_zero() {
            Promise::new(disputer).transfer(excess).detach();
        }
    }

    /// The deposit, on top of the bond, that `dispute` needs for storage.
    pub fn dispute_storage_deposit(&self) -> NearToken {
        Self::dispute_storage()
    }

    /// The exact request a Resolver must send to NEAR AI Cloud for a disputed
    /// Assertion, as a string whose UTF-8 bytes are the request body. Pass
    /// null for Evidence the Assertion or dispute doesn't have. Panics if the
    /// content doesn't match the stored hashes.
    pub fn ai_request(
        &self,
        assertion_id: u64,
        claim: String,
        asserter_evidence: Option<String>,
        disputer_evidence: Option<String>,
    ) -> String {
        let assertion = self.assertion(assertion_id);
        let (dispute, template) = self.verdict_inputs(assertion);
        let content = checked_content(
            assertion,
            dispute,
            &claim,
            &asserter_evidence,
            &disputer_evidence,
        );
        ai::build_request(template, &content, dispute.seed)
    }

    /// Submits an AI Verdict for a disputed Assertion. Anyone can call it.
    ///
    /// `response_body` is the exact response from NEAR AI Cloud, and
    /// `signed_text`, `signature` and `public_key` (hex) come from its
    /// signature endpoint. The first valid TRUE or FALSE verdict rules the
    /// Assertion and opens the Appeal Window. An UNRESOLVABLE verdict, or a
    /// verdict that differs from the first during the Appeal Window
    /// (Conflicting Verdicts), sends it to Appeal. Returns the verdict.
    #[allow(clippy::too_many_arguments)]
    pub fn submit_ai_verdict(
        &mut self,
        assertion_id: u64,
        claim: String,
        asserter_evidence: Option<String>,
        disputer_evidence: Option<String>,
        response_body: String,
        signed_text: String,
        signature: String,
        public_key: String,
    ) -> Verdict {
        let now = env::block_timestamp();
        let assertion = self.assertion(assertion_id);
        let (dispute, template) = self.verdict_inputs(assertion);
        let content = checked_content(
            assertion,
            dispute,
            &claim,
            &asserter_evidence,
            &disputer_evidence,
        );
        let verdict = ai::parse_verdict(&response_body).unwrap_or_else(|| {
            env::panic_str(
                "response_body must hold exactly one verdict: TRUE, FALSE or UNRESOLVABLE",
            )
        });
        let request = ai::build_request(template, &content, dispute.seed);
        let request_hash = hash::sha256(request.as_bytes());
        let response_hash = hash::sha256(response_body.as_bytes());
        let expected_text = format!(
            "{}:{}:{}",
            template.model_id,
            hash::to_hex(&request_hash),
            hash::to_hex(&response_hash)
        );
        require!(
            signed_text == expected_text,
            "signed_text must be model_id:sha256(request):sha256(response) for the pinned model"
        );
        let public_key = hash::parse_bytes::<32>(&public_key)
            .unwrap_or_else(|| env::panic_str("public_key must be 64 hex characters"));
        let signature = hash::parse_bytes::<64>(&signature)
            .unwrap_or_else(|| env::panic_str("signature must be 128 hex characters"));
        require!(
            self.registered_keys.get(&public_key) == Some(&template.model_id),
            format!(
                "public_key is not a Registered Key for {}",
                template.model_id
            )
        );
        require!(
            env::ed25519_verify(&signature, signed_text.as_bytes(), &public_key),
            "signature does not verify against public_key"
        );
        require!(
            !assertion
                .ai_verdicts
                .iter()
                .any(|accepted| accepted.response_hash == response_hash),
            "This response is already recorded"
        );
        let first = match assertion.state {
            AssertionState::Disputed => None,
            AssertionState::Ruled { .. } => {
                require!(
                    now < assertion.appeal_window_ends_at_ns().unwrap_or(0),
                    "Appeal Window has ended"
                );
                let first = assertion.ai_verdicts[0].verdict;
                require!(
                    verdict != first,
                    "This AI Verdict matches the one already accepted"
                );
                Some(first)
            }
            AssertionState::InAppeal => env::panic_str("Assertion is in Appeal"),
            AssertionState::Asserted | AssertionState::Settled { .. } => env::abort(),
        };

        let appeal_window = self.config.appeal_window;
        let dao_deadline = self.config.dao_deadline;
        let assertion = self.assertion_mut(assertion_id);
        assertion.ai_verdicts.push(AcceptedVerdict {
            verdict,
            request_hash,
            response_hash,
            public_key,
            accepted_at_ns: now,
        });
        // Only the first TRUE or FALSE verdict opens the Appeal Window.
        let opens_window = first.is_none() && verdict != Verdict::Unresolvable;
        let appeal_window_ends_at_ns = opens_window.then(|| now + appeal_window * NS_PER_SEC);
        if let Some(ends) = appeal_window_ends_at_ns {
            assertion.state = AssertionState::Ruled {
                outcome: verdict == Verdict::True,
            };
            if let Some(dispute) = assertion.dispute.as_mut() {
                dispute.appeal_window_ends_at_ns = Some(ends);
            }
        }
        Event::AiVerdictAccepted {
            assertion_id,
            verdict,
            resolver: env::predecessor_account_id(),
            request_hash: hash::to_hex(&request_hash),
            response_hash: hash::to_hex(&response_hash),
            public_key: hash::to_hex(&public_key),
            appeal_window_ends_at_ns: appeal_window_ends_at_ns.map(U64),
        }
        .emit();
        match first {
            Some(first) => {
                Event::ConflictingVerdicts {
                    assertion_id,
                    verdicts: vec![first, verdict],
                }
                .emit();
                assertion.start_appeal(assertion_id, AppealReason::Conflicting, now, dao_deadline);
            }
            None if verdict == Verdict::Unresolvable => {
                assertion.start_appeal(assertion_id, AppealReason::Unresolvable, now, dao_deadline);
            }
            None => {}
        }
        verdict
    }
}

impl Oracle {
    fn dispute_storage() -> NearToken {
        env::storage_byte_cost().saturating_mul(DISPUTE_STORAGE_BYTES.into())
    }

    /// The dispute and pinned Prompt Template an AI Verdict is checked against.
    fn verdict_inputs<'a>(&'a self, assertion: &'a Assertion) -> (&'a Dispute, &'a PromptTemplate) {
        let dispute = match (&assertion.state, &assertion.dispute) {
            (AssertionState::Settled { .. }, _) => env::panic_str("Assertion is already settled"),
            (_, Some(dispute)) => dispute,
            (_, None) => env::panic_str("Assertion is not disputed"),
        };
        let template = assertion
            .prompt_template_version
            .and_then(|version| self.prompt_template(version))
            .unwrap_or_else(|| env::panic_str("Assertion has no Prompt Template"));
        (dispute, template)
    }
}

/// Checks each item's sha256 against the stored hash. Missing Evidence must be
/// passed as null, and becomes an empty string in the request.
fn checked_content<'a>(
    assertion: &Assertion,
    dispute: &Dispute,
    claim: &'a str,
    asserter_evidence: &'a Option<String>,
    disputer_evidence: &'a Option<String>,
) -> Content<'a> {
    require!(
        hash::sha256(claim.as_bytes()) == assertion.claim_hash,
        "claim does not match the Assertion's claim_hash"
    );
    require!(
        asserter_evidence
            .as_ref()
            .map(|text| hash::sha256(text.as_bytes()))
            == assertion.evidence_hash,
        "asserter_evidence does not match the Assertion's evidence_hash"
    );
    require!(
        disputer_evidence
            .as_ref()
            .map(|text| hash::sha256(text.as_bytes()))
            == dispute.evidence_hash,
        "disputer_evidence does not match the dispute's evidence_hash"
    );
    Content {
        claim,
        asserter_evidence: asserter_evidence.as_deref().unwrap_or(""),
        disputer_evidence: disputer_evidence.as_deref().unwrap_or(""),
    }
}

/// The seed for an AI request: the first four bytes of the block's random seed.
fn dispute_seed() -> u32 {
    #[cfg(feature = "test-seed")]
    if let Some(seed) = env::storage_read(TEST_SEED_KEY) {
        return u32::from_le_bytes(seed.try_into().unwrap_or_else(|_| env::abort()));
    }
    let random = env::random_seed_array();
    u32::from_le_bytes([random[0], random[1], random[2], random[3]])
}

#[cfg(feature = "test-seed")]
const TEST_SEED_KEY: &[u8] = b"test_seed";

/// Test builds only: the sandbox's random seed can't be chosen, so the test
/// replaying the real NEAR AI Cloud fixture sets the seed it was signed with.
#[cfg(feature = "test-seed")]
#[near]
impl Oracle {
    pub fn set_test_seed(&mut self, seed: u32) {
        env::storage_write(TEST_SEED_KEY, &seed.to_le_bytes());
    }
}
