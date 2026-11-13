//! Appeal and the DAO: Assertions reach Appeal by an appeal, Conflicting
//! Verdicts, an UNRESOLVABLE AI Verdict or no AI Verdict in time, and settle by
//! the DAO's ruling or, after the DAO deadline, by themselves. A test ed25519
//! key stands in for NEAR AI Cloud and `dao.sandbox` acts as the DAO.
mod common;
#[path = "common/evm.rs"]
mod evm;
use common::ai::*;
use common::*;
use near_api::{AccountId, NearToken};
use serde_json::{Value, json};

const BOND: NearToken = NearToken::from_near(1);
const NS: u64 = 1_000_000_000;
/// Gas a rejected call can cost at most; anything above means the deposit was kept.
const GAS_SLACK: NearToken = NearToken::from_millinear(10);
const ZERO: NearToken = NearToken::from_yoctonear(0);

fn content() -> Content {
    Content::new(
        "The haiku in the Asserter's Evidence mentions rain.",
        Some("Grey clouds roll over\nrain taps on the window glass\nthe kettle whistles"),
        Some("The poem never says the word rain."),
    )
}

fn parse_ns(value: &Value) -> u64 {
    value
        .as_str()
        .expect("timestamp string")
        .parse()
        .expect("timestamp")
}

fn yocto(amount: u128) -> NearToken {
    NearToken::from_yoctonear(amount)
}

struct Setup {
    world: World,
    asserter: AccountId,
    disputer: AccountId,
    resolver: AccountId,
    key: TestKey,
}

/// A sandbox with a Prompt Template and Registered Key, with the default timers.
async fn setup_default() -> TestResult<Setup> {
    let world = World::new().await?;
    let asserter = world.create_account("asserter").await?;
    let disputer = world.create_account("disputer").await?;
    let resolver = world.create_account("resolver").await?;
    world
        .publish_template(template(MODEL, "Judge the claim."))
        .await?;
    let key = TestKey::new(7);
    world.register_key(&key, MODEL).await?;
    Ok(Setup {
        world,
        asserter,
        disputer,
        resolver,
        key,
    })
}

/// Like `setup_default`, with the DAO shortening the AI Verdict deadline, the
/// Appeal Window and the DAO deadline to `secs` seconds each.
async fn setup(secs: u64) -> TestResult<Setup> {
    let s = setup_default().await?;
    s.world
        .call(
            &s.world.dao,
            "set_config",
            json!({ "config": {
                "min_bond": NearToken::from_near(1),
                "default_liveness": 7200,
                "max_hooks": 4,
                "max_near_hook_gas": near_api::NearGas::from_tgas(50),
                "appeal_window": secs,
                "ai_verdict_deadline": secs,
                "dao_deadline": secs,
            } }),
            ONE_YOCTO,
        )
        .await?
        .assert_success();
    Ok(s)
}

impl Setup {
    /// Posts `content` with a 10-minute Liveness and disputes it.
    async fn disputed(&self, content: &Content, bond: NearToken) -> TestResult<u64> {
        let id = self
            .world
            .post_content(&self.asserter, content, bond, 600)
            .await?;
        self.world
            .dispute_ok(&self.disputer, id, content, bond)
            .await?;
        Ok(id)
    }

    async fn submit(&self, id: u64, content: &Content, verdict: &str) -> TestResult<ExecResult> {
        self.world
            .submit_signed_verdict(&self.resolver, id, content, &self.key, verdict)
            .await
    }

    /// A disputed Assertion with an accepted AI Verdict.
    async fn ruled(&self, content: &Content, bond: NearToken, verdict: &str) -> TestResult<u64> {
        let id = self.disputed(content, bond).await?;
        self.submit(id, content, verdict).await?.assert_success();
        Ok(id)
    }

    async fn resolve_appeal(
        &self,
        caller: &AccountId,
        id: u64,
        truthful: bool,
    ) -> TestResult<ExecResult> {
        self.world
            .call(
                caller,
                "resolve_appeal",
                json!({ "assertion_id": id, "truthful": truthful }),
                ONE_YOCTO,
            )
            .await
    }

    async fn appeal(
        &self,
        caller: &AccountId,
        id: u64,
        deposit: NearToken,
    ) -> TestResult<ExecResult> {
        self.world
            .call(caller, "appeal", json!({ "assertion_id": id }), deposit)
            .await
    }

    async fn check_timeout(&self, id: u64) -> TestResult<ExecResult> {
        self.world
            .call(
                &self.resolver,
                "check_timeout",
                json!({ "assertion_id": id }),
                ZERO,
            )
            .await
    }

    async fn balances(&self) -> TestResult<[NearToken; 3]> {
        Ok([
            self.world.oracle_balance_of(&self.asserter).await?,
            self.world.oracle_balance_of(&self.disputer).await?,
            self.world.oracle_balance_of(&self.world.dao).await?,
        ])
    }

    /// Waits until the Assertion's DAO deadline has passed.
    async fn wait_for_dao_deadline(&self, id: u64) -> TestResult {
        let deadline = parse_ns(&self.world.assertion(id).await?["appeal"]["dao_deadline_ns"]);
        self.world.advance_clock_to(deadline).await
    }
}

type ExecResult = near_api::types::transaction::result::ExecutionFinalResult;

/// The events after the first one, which is `ai_verdict_accepted`.
fn events_after_verdict(result: &ExecResult) -> Vec<(String, Value)> {
    let events = enzure_events(result);
    assert_eq!(events[0].0, "ai_verdict_accepted");
    events[1..].to_vec()
}

#[tokio::test]
async fn an_unresolvable_ai_verdict_sends_the_assertion_to_appeal_and_the_dao_settles_it()
-> TestResult {
    let s = setup_default().await?;
    let world = &s.world;
    let content = content();
    let id = s.disputed(&content, BOND).await?;

    let accepted = s.submit(id, &content, "UNRESOLVABLE").await?;
    let events = enzure_events(&accepted);
    assert_eq!(accepted.json::<String>()?, "UNRESOLVABLE");
    let assertion = world.assertion(id).await?;
    assert_eq!(assertion["state"], "in_appeal");
    assert_eq!(assertion["ai_verdicts"][0]["verdict"], "UNRESOLVABLE");
    assert_eq!(assertion["appeal_window_ends_at_ns"], Value::Null);
    let appeal = &assertion["appeal"];
    assert_eq!(appeal["reason"], "unresolvable");
    assert_eq!(appeal["appellant"], Value::Null);
    assert_eq!(appeal["appeal_bond"], Value::Null);
    // The DAO deadline is 7 days by default.
    assert_eq!(
        parse_ns(&appeal["dao_deadline_ns"]) - parse_ns(&appeal["started_at_ns"]),
        7 * 24 * 60 * 60 * NS
    );
    assert_eq!(events[0].0, "ai_verdict_accepted");
    assert_eq!(events[0].1["verdict"], "UNRESOLVABLE");
    assert_eq!(events[0].1["appeal_window_ends_at_ns"], Value::Null);
    assert_eq!(
        events[1..],
        [(
            "appeal_started".to_string(),
            json!({
                "assertion_id": id,
                "reason": "unresolvable",
                "appellant": null,
                "appeal_bond": null,
                "dao_deadline_ns": appeal["dao_deadline_ns"],
            })
        )]
    );
    let early = world.settle(&s.resolver, id).await?;
    assert!(failure_message(early).contains("Appeal is waiting for the DAO"));

    // Only the DAO rules.
    let by_stranger = s.resolve_appeal(&s.asserter, id, true).await?;
    assert!(failure_message(by_stranger).contains("Only the DAO can resolve an Appeal"));
    let ruled = s.resolve_appeal(&world.dao, id, true).await?;
    let events = enzure_events(&ruled);
    assert!(ruled.json::<bool>()?);
    // The Asserter wins: its bond plus half the Disputer's; the DAO the other half.
    let half = yocto(BOND.as_yoctonear() / 2);
    let winner_gets = BOND.saturating_add(half);
    assert_eq!(
        events,
        [
            (
                "appeal_resolved".to_string(),
                json!({ "assertion_id": id, "outcome": true })
            ),
            (
                "assertion_settled".to_string(),
                json!({
                    "assertion_id": id,
                    "outcome": true,
                    "payouts": [
                        { "account_id": s.asserter, "amount": winner_gets },
                        { "account_id": world.dao, "amount": half },
                    ],
                })
            ),
        ]
    );
    assert_eq!(s.balances().await?, [winner_gets, ZERO, half]);
    let assertion = world.assertion(id).await?;
    assert_eq!(assertion["state"], "settled");
    assert_eq!(assertion["outcome"], true);
    let again = s.resolve_appeal(&world.dao, id, false).await?;
    assert!(failure_message(again).contains("already settled"));
    Ok(())
}

#[tokio::test]
async fn an_overdue_unresolvable_appeal_settles_false_and_returns_every_bond() -> TestResult {
    let s = setup(60).await?;
    let world = &s.world;
    let content = content();
    let bond = NearToken::from_near(2);
    let id = s.ruled(&content, bond, "UNRESOLVABLE").await?;
    assert_eq!(world.assertion(id).await?["state"], "in_appeal");

    s.wait_for_dao_deadline(id).await?;
    let settled = world.settle(&s.resolver, id).await?;
    let events = enzure_events(&settled);
    assert!(!settled.json::<bool>()?);
    assert_eq!(
        events[0].1["payouts"],
        json!([
            { "account_id": s.asserter, "amount": bond },
            { "account_id": s.disputer, "amount": bond },
        ])
    );
    assert_eq!(s.balances().await?, [bond, bond, ZERO]);
    Ok(())
}

#[tokio::test]
async fn conflicting_verdicts_send_the_assertion_to_appeal_and_an_overdue_one_settles_false()
-> TestResult {
    let s = setup(60).await?;
    let world = &s.world;
    let content = content();
    let bond = NearToken::from_near(2);
    let id = s.ruled(&content, bond, "TRUE").await?;
    let request = world.ai_request(id, &content).await?;

    // Another response with the same verdict changes nothing.
    let same = Submission::signed(&s.key, MODEL, &request, &verdict_response("again", "TRUE"));
    let same = world
        .submit_verdict(&s.resolver, id, &content, &same)
        .await?;
    assert!(failure_message(same).contains("matches the one already accepted"));
    assert_eq!(world.assertion(id).await?["state"], "ruled");

    // A differing verdict during the Appeal Window: Conflicting Verdicts.
    let differing =
        Submission::signed(&s.key, MODEL, &request, &verdict_response("other", "FALSE"));
    let conflicting = world
        .submit_verdict(&s.resolver, id, &content, &differing)
        .await?;
    let accepted = enzure_events(&conflicting)[0].1.clone();
    assert_eq!(accepted["verdict"], "FALSE");
    assert_eq!(accepted["appeal_window_ends_at_ns"], Value::Null);
    let assertion = world.assertion(id).await?;
    assert_eq!(assertion["state"], "in_appeal");
    let verdicts: Vec<&Value> = assertion["ai_verdicts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| &v["verdict"])
        .collect();
    assert_eq!(verdicts, [&json!("TRUE"), &json!("FALSE")]);
    let appeal = &assertion["appeal"];
    assert_eq!(appeal["reason"], "conflicting");
    assert_eq!(appeal["appellant"], Value::Null);
    assert_eq!(
        parse_ns(&appeal["dao_deadline_ns"]) - parse_ns(&appeal["started_at_ns"]),
        60 * NS
    );
    assert_eq!(
        events_after_verdict(&conflicting),
        [
            (
                "conflicting_verdicts".to_string(),
                json!({ "assertion_id": id, "verdicts": ["TRUE", "FALSE"] })
            ),
            (
                "appeal_started".to_string(),
                json!({
                    "assertion_id": id,
                    "reason": "conflicting",
                    "appellant": null,
                    "appeal_bond": null,
                    "dao_deadline_ns": appeal["dao_deadline_ns"],
                })
            ),
        ]
    );

    // In Appeal, no more AI Verdicts or appeals count.
    let third = Submission::signed(
        &s.key,
        MODEL,
        &request,
        &verdict_response("third", "UNRESOLVABLE"),
    );
    let third = world
        .submit_verdict(&s.resolver, id, &content, &third)
        .await?;
    assert!(failure_message(third).contains("Assertion is in Appeal"));
    let appeal = s.appeal(&s.disputer, id, bond).await?;
    assert!(failure_message(appeal).contains("already in Appeal"));
    let early = world.settle(&s.resolver, id).await?;
    assert!(failure_message(early).contains("Appeal is waiting for the DAO"));

    // The DAO misses its deadline: FALSE, and every bond goes back in full.
    s.wait_for_dao_deadline(id).await?;
    let late = s.resolve_appeal(&world.dao, id, true).await?;
    assert!(failure_message(late).contains("DAO deadline has passed"));
    let settled = world.settle(&s.resolver, id).await?;
    let events = enzure_events(&settled);
    assert!(!settled.json::<bool>()?);
    assert_eq!(
        events,
        [(
            "assertion_settled".to_string(),
            json!({
                "assertion_id": id,
                "outcome": false,
                "payouts": [
                    { "account_id": s.asserter, "amount": bond },
                    { "account_id": s.disputer, "amount": bond },
                ],
            })
        )]
    );
    assert_eq!(s.balances().await?, [bond, bond, ZERO]);
    assert_eq!(world.assertion(id).await?["outcome"], false);
    Ok(())
}

#[tokio::test]
async fn after_the_appeal_window_neither_a_differing_verdict_nor_an_appeal_is_accepted()
-> TestResult {
    let s = setup(60).await?;
    let world = &s.world;
    let content = content();
    let id = s.ruled(&content, BOND, "TRUE").await?;
    world
        .advance_clock_to(parse_ns(
            &world.assertion(id).await?["appeal_window_ends_at_ns"],
        ))
        .await?;

    let late_verdict = s.submit(id, &content, "FALSE").await?;
    assert!(failure_message(late_verdict).contains("Appeal Window has ended"));
    let before = world.near_balance(&s.disputer).await?;
    let late_appeal = s.appeal(&s.disputer, id, BOND).await?;
    assert!(failure_message(late_appeal).contains("Appeal Window has ended"));
    let spent = before.saturating_sub(world.near_balance(&s.disputer).await?);
    assert!(spent < GAS_SLACK, "a rejected appeal kept {spent}");

    assert!(world.settle(&s.resolver, id).await?.json::<bool>()?);
    Ok(())
}

#[tokio::test]
async fn only_the_party_that_lost_the_ai_verdict_appeals_once_with_a_matching_bond_and_wins_it_back()
-> TestResult {
    let s = setup_default().await?;
    let world = &s.world;
    let content = content();
    let bond = NearToken::from_near(2);
    let disputed = s.disputed(&content, bond).await?;
    let early = s.appeal(&s.asserter, disputed, bond).await?;
    assert!(failure_message(early).contains("has no AI Verdict to Appeal"));

    // TRUE: the Disputer lost.
    let id = s.ruled(&content, bond, "TRUE").await?;
    let stranger = world.create_account("stranger").await?;
    for caller in [&s.asserter, &stranger] {
        let before = world.near_balance(caller).await?;
        let rejected = s.appeal(caller, id, bond).await?;
        assert!(
            failure_message(rejected)
                .contains("Only the party that lost the AI Verdict can Appeal")
        );
        let spent = before.saturating_sub(world.near_balance(caller).await?);
        assert!(spent < GAS_SLACK, "a rejected appeal kept {spent}");
    }
    let before = world.near_balance(&s.disputer).await?;
    let short = s
        .appeal(&s.disputer, id, bond.saturating_sub(yocto(1)))
        .await?;
    assert!(failure_message(short).contains("Attach an appeal bond equal to the Assertion's bond"));
    let spent = before.saturating_sub(world.near_balance(&s.disputer).await?);
    assert!(spent < GAS_SLACK, "a rejected appeal kept {spent}");

    // Extra deposit is refunded.
    let before = world.near_balance(&s.disputer).await?;
    let appealed = s
        .appeal(
            &s.disputer,
            id,
            bond.saturating_add(NearToken::from_near(3)),
        )
        .await?;
    let events = enzure_events(&appealed);
    appealed.assert_success();
    let spent = before.saturating_sub(world.near_balance(&s.disputer).await?);
    assert!(
        spent >= bond && spent < bond.saturating_add(GAS_SLACK),
        "spent {spent}"
    );
    let assertion = world.assertion(id).await?;
    assert_eq!(assertion["state"], "in_appeal");
    let appeal = &assertion["appeal"];
    assert_eq!(appeal["reason"], "appealed");
    assert_eq!(appeal["appellant"], s.disputer.as_str());
    assert_eq!(appeal["appeal_bond"], json!(bond));
    assert_eq!(
        parse_ns(&appeal["dao_deadline_ns"]) - parse_ns(&appeal["started_at_ns"]),
        7 * 24 * 60 * 60 * NS
    );
    assert_eq!(
        events,
        [(
            "appeal_started".to_string(),
            json!({
                "assertion_id": id,
                "reason": "appealed",
                "appellant": s.disputer,
                "appeal_bond": bond,
                "dao_deadline_ns": appeal["dao_deadline_ns"],
            })
        )]
    );
    let again = s.appeal(&s.disputer, id, bond).await?;
    assert!(failure_message(again).contains("already in Appeal"));

    // The DAO rules for the appellant: the appeal bond comes back, plus the
    // Disputer's own bond and half the Asserter's. The DAO gets the other half.
    let without_yocto = world
        .call(
            &world.dao,
            "resolve_appeal",
            json!({ "assertion_id": id, "truthful": false }),
            ZERO,
        )
        .await?;
    assert!(failure_message(without_yocto).contains("exactly 1 yoctoNEAR"));
    let ruled = s.resolve_appeal(&world.dao, id, false).await?;
    let events = enzure_events(&ruled);
    assert!(!ruled.json::<bool>()?);
    assert_eq!(
        events,
        [
            (
                "appeal_resolved".to_string(),
                json!({ "assertion_id": id, "outcome": false })
            ),
            (
                "assertion_settled".to_string(),
                json!({
                    "assertion_id": id,
                    "outcome": false,
                    "payouts": [
                        { "account_id": s.disputer, "amount": NearToken::from_near(5) },
                        { "account_id": world.dao, "amount": NearToken::from_near(1) },
                    ],
                })
            ),
        ]
    );
    assert_eq!(
        s.balances().await?,
        [ZERO, NearToken::from_near(5), NearToken::from_near(1)]
    );
    Ok(())
}

#[tokio::test]
async fn an_appellant_who_loses_forfeits_half_the_appeal_bond_to_the_other_party_and_half_to_the_dao()
-> TestResult {
    let s = setup_default().await?;
    let world = &s.world;
    let content = content();
    // An odd bond: each odd yoctoNEAR goes to the winner.
    let bond = yocto(10u128.pow(24) + 1);
    // FALSE: the Asserter lost and appeals.
    let id = s.ruled(&content, bond, "FALSE").await?;
    let by_disputer = s.appeal(&s.disputer, id, bond).await?;
    assert!(failure_message(by_disputer).contains("Only the party that lost"));
    s.appeal(&s.asserter, id, bond).await?.assert_success();
    assert_eq!(
        world.assertion(id).await?["appeal"]["appellant"],
        s.asserter.as_str()
    );

    let ruled = s.resolve_appeal(&world.dao, id, false).await?;
    // Disputer: own bond 1e24+1, plus 5e23+1 of the Asserter's bond and 5e23+1
    // of the appeal bond. DAO: 5e23 of each.
    let disputer_gets = yocto(2 * 10u128.pow(24) + 3);
    let dao_gets = yocto(10u128.pow(24));
    assert_eq!(
        enzure_events(&ruled)[1].1["payouts"],
        json!([
            { "account_id": s.disputer, "amount": disputer_gets },
            { "account_id": world.dao, "amount": dao_gets },
        ])
    );
    assert_eq!(s.balances().await?, [ZERO, disputer_gets, dao_gets]);
    Ok(())
}

#[tokio::test]
async fn an_overdue_appeal_settles_by_the_ai_verdict_and_returns_the_appeal_bond() -> TestResult {
    let s = setup(60).await?;
    let world = &s.world;
    let content = content();
    let bond = NearToken::from_near(2);
    let id = s.ruled(&content, bond, "TRUE").await?;
    s.appeal(&s.disputer, id, bond).await?.assert_success();

    s.wait_for_dao_deadline(id).await?;
    let settled = world.settle(&s.asserter, id).await?;
    let events = enzure_events(&settled);
    assert!(settled.json::<bool>()?);
    assert_eq!(
        events,
        [(
            "assertion_settled".to_string(),
            json!({
                "assertion_id": id,
                "outcome": true,
                "payouts": [
                    { "account_id": s.asserter, "amount": NearToken::from_near(3) },
                    { "account_id": world.dao, "amount": NearToken::from_near(1) },
                    { "account_id": s.disputer, "amount": bond },
                ],
            })
        )]
    );
    assert_eq!(
        s.balances().await?,
        [NearToken::from_near(3), bond, NearToken::from_near(1)]
    );
    Ok(())
}

#[tokio::test]
async fn the_ai_verdict_deadline_is_one_hour_by_default() -> TestResult {
    let s = setup_default().await?;
    let content = content();
    let id = s.disputed(&content, BOND).await?;
    let dispute = &s.world.assertion(id).await?["dispute"];
    assert_eq!(
        parse_ns(&dispute["ai_verdict_deadline_ns"]) - parse_ns(&dispute["disputed_at_ns"]),
        60 * 60 * NS
    );
    let early = s.check_timeout(id).await?;
    assert!(failure_message(early).contains("AI Verdict deadline has not passed"));
    Ok(())
}

#[tokio::test]
async fn check_timeout_sends_a_disputed_assertion_with_no_ai_verdict_to_appeal() -> TestResult {
    let s = setup(60).await?;
    let world = &s.world;
    let content = content();
    let bond = NearToken::from_near(2);
    let undisputed = world.post_content(&s.asserter, &content, bond, 600).await?;
    let not_disputed = s.check_timeout(undisputed).await?;
    assert!(failure_message(not_disputed).contains("not disputed"));
    let ruled = s.ruled(&content, bond, "TRUE").await?;
    let has_verdict = s.check_timeout(ruled).await?;
    assert!(failure_message(has_verdict).contains("already has an AI Verdict"));
    let not_in_appeal = s.resolve_appeal(&world.dao, ruled, true).await?;
    assert!(failure_message(not_in_appeal).contains("not in Appeal"));

    let id = s.disputed(&content, bond).await?;
    let early = s.check_timeout(id).await?;
    assert!(failure_message(early).contains("AI Verdict deadline has not passed"));
    world
        .advance_clock_to(parse_ns(
            &world.assertion(id).await?["dispute"]["ai_verdict_deadline_ns"],
        ))
        .await?;
    // Anyone can call it.
    let timed_out = s.check_timeout(id).await?;
    let events = enzure_events(&timed_out);
    timed_out.assert_success();
    let assertion = world.assertion(id).await?;
    assert_eq!(assertion["state"], "in_appeal");
    assert_eq!(assertion["appeal"]["reason"], "no_verdict");
    assert_eq!(
        events,
        [(
            "appeal_started".to_string(),
            json!({
                "assertion_id": id,
                "reason": "no_verdict",
                "appellant": null,
                "appeal_bond": null,
                "dao_deadline_ns": assertion["appeal"]["dao_deadline_ns"],
            })
        )]
    );
    let again = s.check_timeout(id).await?;
    assert!(failure_message(again).contains("already in Appeal"));
    let late_verdict = s.submit(id, &content, "TRUE").await?;
    assert!(failure_message(late_verdict).contains("Assertion is in Appeal"));

    // The DAO misses its deadline: FALSE, with both bonds returned.
    s.wait_for_dao_deadline(id).await?;
    let settled = world.settle(&s.resolver, id).await?;
    assert_eq!(
        enzure_events(&settled)[0].1["payouts"],
        json!([
            { "account_id": s.asserter, "amount": bond },
            { "account_id": s.disputer, "amount": bond },
        ])
    );
    assert!(!settled.json::<bool>()?);
    Ok(())
}

/// The DAO's ruling settles the Assertion like `settle` does: the NEAR Consumer
/// is called and anyone can sign the EVM Hook.
#[tokio::test]
async fn the_daos_ruling_delivers_near_hooks_and_allows_evm_hook_signing() -> TestResult {
    let evm = evm::EvmWorld::new().await?;
    let world = &evm.world;
    let asserter = world.create_account("asserter").await?;
    let disputer = world.create_account("disputer").await?;
    let resolver = world.create_account("resolver").await?;
    world
        .publish_template(template(MODEL, "Judge the claim."))
        .await?;
    let key = TestKey::new(7);
    world.register_key(&key, MODEL).await?;
    let consumer = world
        .deploy(
            "consumer",
            example_near_consumer_wasm(),
            Some(("new", json!({ "oracle": world.oracle }))),
        )
        .await?;

    let content = Content::new("The sky is green.", None, None);
    let hooks = json!([
        { "near": { "consumer": consumer, "gas": near_api::NearGas::from_tgas(20) } },
        evm::evm_hook(),
    ]);
    let id: u64 = world
        .call(
            &asserter,
            "assert_claim",
            json!({
                "claim_hash": sha256_hex(&content.claim),
                "bond": BOND,
                "liveness": 600,
                "hooks": hooks,
            }),
            BOND.saturating_add(world.storage_deposit_for(2).await?),
        )
        .await?
        .json()?;
    world.dispute_ok(&disputer, id, &content, BOND).await?;
    world
        .submit_signed_verdict(&resolver, id, &content, &key, "UNRESOLVABLE")
        .await?
        .assert_success();
    let early = evm.sign_hook(&resolver, id, 1, ONE_YOCTO).await?;
    assert!(failure_message(early).contains("not settled"));

    let ruled = world
        .call(
            &world.dao,
            "resolve_appeal",
            json!({ "assertion_id": id, "truthful": true }),
            ONE_YOCTO,
        )
        .await?;
    let names: Vec<String> = enzure_events(&ruled).into_iter().map(|e| e.0).collect();
    assert_eq!(
        names,
        [
            "appeal_resolved",
            "assertion_settled",
            "near_hook_delivered"
        ]
    );
    let recorded: Option<bool> = world
        .view_contract(&consumer, "get_outcome", json!({ "assertion_id": id }))
        .await?;
    assert_eq!(recorded, Some(true));

    let signed = evm.sign_hook(&resolver, id, 1, ONE_YOCTO).await?;
    assert!(signed.json::<bool>()?);
    let result = evm.signed_result(id, 1).await?;
    assert_eq!(result["outcome"], true);
    assert_eq!(result["assertion_id"], id);
    Ok(())
}

/// A Sputnik proposal gives `resolve_appeal` a fixed amount of gas (the
/// scripts give 150 TGas), often less than the NEAR Hooks need. The ruling
/// still settles the Assertion; Hooks it had no gas for stay pending, and
/// anyone delivers them with `retry_near_hook`, each with its fixed gas.
#[tokio::test]
async fn the_daos_ruling_settles_even_without_gas_for_every_near_hook() -> TestResult {
    let s = setup_default().await?;
    let world = &s.world;
    let mut consumers = Vec::new();
    for name in ["first", "second", "third", "fourth"] {
        consumers.push(world.deploy(name, switchable_consumer_wasm(), None).await?);
    }
    let hooks: Vec<Value> = consumers
        .iter()
        .map(|c| json!({ "near": { "consumer": c, "gas": near_api::NearGas::from_tgas(50) } }))
        .collect();
    let content = Content::new("The sky is green.", None, None);
    let id: u64 = world
        .call(
            &s.asserter,
            "assert_claim",
            json!({
                "claim_hash": sha256_hex(&content.claim),
                "bond": BOND,
                "liveness": 600,
                "hooks": hooks,
            }),
            BOND.saturating_add(world.storage_deposit_for(4).await?),
        )
        .await?
        .json()?;
    world.dispute_ok(&s.disputer, id, &content, BOND).await?;
    s.submit(id, &content, "UNRESOLVABLE").await?.assert_success();

    let ruled = world
        .call_contract_with_gas(
            &world.dao,
            &world.oracle,
            "resolve_appeal",
            json!({ "assertion_id": id, "truthful": true }),
            ONE_YOCTO,
            near_api::NearGas::from_tgas(150),
        )
        .await?;
    assert!(ruled.clone().json::<bool>()?);
    let assertion = world.assertion(id).await?;
    assert_eq!(assertion["state"], "settled");
    assert_eq!(assertion["outcome"], true);
    let half = yocto(BOND.as_yoctonear() / 2);
    assert_eq!(s.balances().await?, [BOND.saturating_add(half), ZERO, half]);
    let statuses: Vec<Value> = assertion["hooks"]
        .as_array()
        .expect("hooks list")
        .iter()
        .map(|hook| hook["near"]["status"].clone())
        .collect();
    let delivered = statuses.iter().filter(|s| *s == "delivered").count();
    assert!(
        (1..4).contains(&delivered)
            && statuses.iter().all(|s| s == "delivered" || s == "pending"),
        "{statuses:?}"
    );
    let delivered_events = enzure_events(&ruled)
        .into_iter()
        .filter(|(name, _)| name == "near_hook_delivered")
        .count();
    assert_eq!(delivered_events, delivered);

    // Anyone delivers the pending Hooks, each with exactly its fixed gas.
    for (index, status) in statuses.iter().enumerate() {
        if status == "pending" {
            let retried = world
                .call(
                    &s.resolver,
                    "retry_near_hook",
                    json!({ "assertion_id": id, "hook_index": index }),
                    ZERO,
                )
                .await?;
            assert!(retried.json::<bool>()?, "Hook {index}");
        }
    }
    for consumer in &consumers {
        let deliveries: Value = world
            .view_contract(consumer, "get_deliveries", json!({}))
            .await?;
        assert_eq!(
            deliveries,
            json!([{
                "assertion_id": id,
                "truthful": true,
                "prepaid_gas": near_api::NearGas::from_tgas(50).as_gas().to_string(),
            }])
        );
    }
    let again = world
        .call(
            &s.resolver,
            "retry_near_hook",
            json!({ "assertion_id": id, "hook_index": 0 }),
            ZERO,
        )
        .await?;
    assert!(failure_message(again).contains("already delivered"));
    Ok(())
}

/// Appeal state, a second AI Verdict and every payout fit in what the Asserter
/// and Disputer paid for storage, even with the longest account ids.
#[tokio::test]
async fn the_assertion_and_dispute_deposits_cover_every_appeal_path() -> TestResult {
    let s = setup(60).await?;
    let world = &s.world;
    let byte_cost = NearToken::from_yoctonear(10u128.pow(19));
    let asserter = world.create_account(&"a".repeat(56)).await?;
    let disputer = world.create_account(&"d".repeat(56)).await?;
    let paid = world
        .storage_deposit()
        .await?
        .saturating_add(world.dispute_storage_deposit().await?);
    let content = content();

    for path in ["appealed", "conflicting"] {
        let used_before = world.storage_usage(&world.oracle).await?;
        let id = world.post_content(&asserter, &content, BOND, 600).await?;
        world.dispute_ok(&disputer, id, &content, BOND).await?;
        s.submit(id, &content, "TRUE").await?.assert_success();
        if path == "appealed" {
            s.appeal(&disputer, id, BOND).await?.assert_success();
        } else {
            s.submit(id, &content, "FALSE").await?.assert_success();
        }
        s.wait_for_dao_deadline(id).await?;
        world.settle(&s.resolver, id).await?.assert_success();
        let used = world.storage_usage(&world.oracle).await? - used_before;
        assert!(
            byte_cost.saturating_mul(used.into()) <= paid,
            "{path}: {used} bytes, more than the deposits pay for"
        );
        // Withdraw so the next path creates its balance entries afresh.
        for account in [&asserter, &disputer] {
            world
                .call(account, "withdraw", json!({}), ONE_YOCTO)
                .await?
                .assert_success();
        }
    }
    Ok(())
}
