//! Appeal and the DAO: Assertions reach Appeal by an appeal, Conflicting
//! Verdicts, an UNRESOLVABLE AI Verdict or no AI Verdict in time, and settle by
//! the DAO's ruling or, after the DAO deadline, by themselves. A test ed25519
//! key stands in for NEAR AI Cloud and `dao.sandbox` acts as the DAO.
mod common;

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
