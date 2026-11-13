//! Disputes and AI Verdicts: a test ed25519 key stands in for NEAR AI Cloud and
//! `dao.sandbox` acts as the DAO.
mod common;
#[path = "common/evm.rs"]
mod evm;

use common::ai::*;
use common::*;
use near_api::{AccountId, NearToken};
use serde_json::{Value, json};

const BOND: NearToken = NearToken::from_near(1);
/// Gas a rejected call can cost at most; anything above means the deposit was kept.
const GAS_SLACK: NearToken = NearToken::from_millinear(10);

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

/// A sandbox with a published Prompt Template for `MODEL` and `key` registered for it.
struct Setup {
    world: World,
    asserter: AccountId,
    disputer: AccountId,
    resolver: AccountId,
    key: TestKey,
}

async fn setup() -> TestResult<Setup> {
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
}

type ExecResult = near_api::types::transaction::result::ExecutionFinalResult;

#[tokio::test]
async fn dispute_is_accepted_only_during_liveness_with_a_matching_bond() -> TestResult {
    let s = setup().await?;
    let world = &s.world;
    let content = content();
    let storage = world.dispute_storage_deposit().await?;
    assert!(storage > NearToken::from_yoctonear(0));
    let id = world.post_content(&s.asserter, &content, BOND, 600).await?;
    let evidence = content.disputer_evidence.as_deref();

    // Too little: the bond alone, without the storage deposit. The deposit comes back.
    let before = world.near_balance(&s.disputer).await?;
    let short = world.dispute(&s.disputer, id, evidence, BOND).await?;
    assert!(
        failure_message(short).contains("Attach the Assertion's bond plus the storage deposit")
    );
    let spent = before.saturating_sub(world.near_balance(&s.disputer).await?);
    assert!(spent < GAS_SLACK, "a rejected dispute kept {spent}");

    let bad_hash = world
        .call(
            &s.disputer,
            "dispute",
            json!({ "assertion_id": id, "evidence_hash": "not-a-hash" }),
            BOND.saturating_add(storage),
        )
        .await?;
    assert!(failure_message(bad_hash).contains("evidence_hash must be a sha256 hash"));
    let missing = world
        .dispute(&s.disputer, 99, evidence, BOND.saturating_add(storage))
        .await?;
    assert!(failure_message(missing).contains("Assertion 99 not found"));

    // Extra deposit above bond plus storage is refunded.
    let before = world.near_balance(&s.disputer).await?;
    let disputed = world
        .dispute(
            &s.disputer,
            id,
            evidence,
            BOND.saturating_add(storage)
                .saturating_add(NearToken::from_near(2)),
        )
        .await?;
    let events = enzure_events(&disputed);
    disputed.assert_success();
    let spent = before.saturating_sub(world.near_balance(&s.disputer).await?);
    let kept = BOND.saturating_add(storage);
    assert!(
        spent >= kept && spent < kept.saturating_add(GAS_SLACK),
        "spent {spent}"
    );

    let assertion = world.assertion(id).await?;
    assert_eq!(assertion["state"], "disputed");
    let dispute = &assertion["dispute"];
    assert_eq!(dispute["disputer"], s.disputer.as_str());
    assert_eq!(
        dispute["evidence_hash"],
        sha256_hex(content.disputer_evidence.as_ref().unwrap())
    );
    assert!(dispute["seed"].is_u64());
    assert_eq!(
        events,
        [(
            "assertion_disputed".to_string(),
            json!({
                "assertion_id": id,
                "disputer": s.disputer,
                "evidence_hash": dispute["evidence_hash"],
                "bond": BOND,
                "seed": dispute["seed"],
            })
        )]
    );

    // A second dispute is rejected and its deposit returned.
    let second_disputer = world.create_account("second").await?;
    let before = world.near_balance(&second_disputer).await?;
    let second = world
        .dispute(&second_disputer, id, None, BOND.saturating_add(storage))
        .await?;
    assert!(failure_message(second).contains("already disputed"));
    let spent = before.saturating_sub(world.near_balance(&second_disputer).await?);
    assert!(spent < GAS_SLACK, "a rejected second dispute kept {spent}");
    assert_eq!(world.assertion(id).await?["dispute"], *dispute);
    Ok(())
}

#[tokio::test]
async fn dispute_and_undisputed_settlement_share_the_liveness_boundary() -> TestResult {
    let s = setup().await?;
    let world = &s.world;
    let content = content();
    let deposit = BOND.saturating_add(world.dispute_storage_deposit().await?);
    let early = world.post_content(&s.asserter, &content, BOND, 60).await?;
    let late = world.post_content(&s.asserter, &content, BOND, 60).await?;

    // During Liveness: settlement is rejected and a dispute is accepted.
    let settle = world.settle(&s.resolver, early).await?;
    assert!(failure_message(settle).contains("Liveness has not ended"));
    world
        .dispute(
            &s.disputer,
            early,
            content.disputer_evidence.as_deref(),
            deposit,
        )
        .await?
        .assert_success();
    let settle = world.settle(&s.resolver, early).await?;
    assert!(failure_message(settle).contains("disputed and has no AI Verdict"));

    // Once Liveness has ended: a dispute is rejected and settlement is accepted.
    let ends = parse_ns(&world.assertion(late).await?["liveness_ends_at_ns"]);
    world.advance_clock_to(ends).await?;
    let before = world.near_balance(&s.disputer).await?;
    let dispute = world
        .dispute(
            &s.disputer,
            late,
            content.disputer_evidence.as_deref(),
            deposit,
        )
        .await?;
    assert!(failure_message(dispute).contains("Liveness has ended"));
    let spent = before.saturating_sub(world.near_balance(&s.disputer).await?);
    assert!(spent < GAS_SLACK, "a rejected dispute kept {spent}");
    world.settle(&s.resolver, late).await?.assert_success();
    let dispute = world
        .dispute(
            &s.disputer,
            late,
            content.disputer_evidence.as_deref(),
            deposit,
        )
        .await?;
    assert!(failure_message(dispute).contains("already settled"));
    Ok(())
}

#[tokio::test]
async fn only_the_dao_publishes_prompt_templates_and_manages_registered_keys() -> TestResult {
    let world = World::new().await?;
    let stranger = world.create_account("stranger").await?;
    let key = TestKey::new(1);
    let v1 = template(MODEL, "Judge the claim.");
    let add = json!({ "public_key": key.public_hex(), "model_id": MODEL });
    let remove = json!({ "public_key": key.public_hex() });

    for (method, args) in [
        ("publish_prompt_template", json!({ "template": v1 })),
        ("add_registered_key", add.clone()),
        ("remove_registered_key", remove.clone()),
    ] {
        let by_stranger = world
            .call(&stranger, method, args.clone(), ONE_YOCTO)
            .await?;
        assert!(
            failure_message(by_stranger).contains("Only the DAO"),
            "{method} by a stranger"
        );
        let without_yocto = world
            .call(&world.dao, method, args, NearToken::from_yoctonear(0))
            .await?;
        assert!(
            failure_message(without_yocto).contains("exactly 1 yoctoNEAR"),
            "{method} without one yoctoNEAR"
        );
    }
    let none: Option<Value> = world.view("get_prompt_template", json!({})).await?;
    assert_eq!(none, None);
    let keys: Vec<Value> = world.view("get_registered_keys", json!({})).await?;
    assert!(keys.is_empty());

    let invalid = world
        .call(
            &world.dao,
            "publish_prompt_template",
            json!({ "template": template("bad:model", "Judge.") }),
            ONE_YOCTO,
        )
        .await?;
    assert!(failure_message(invalid).contains("model_id must not contain ':'"));

    let published = world
        .call(
            &world.dao,
            "publish_prompt_template",
            json!({ "template": v1 }),
            ONE_YOCTO,
        )
        .await?;
    assert_eq!(
        enzure_events(&published),
        [(
            "prompt_template_published".to_string(),
            json!({ "version": 1, "model_id": MODEL })
        )]
    );
    assert_eq!(published.json::<u32>()?, 1);
    let current: Value = world.view("get_prompt_template", json!({})).await?;
    assert_eq!(
        current,
        json!({
            "version": 1,
            "model_id": MODEL,
            "system_prompt": "Judge the claim.",
            "temperature": 0.0,
            "max_tokens": 64,
            "enable_thinking": false,
        })
    );

    let added = world
        .call(&world.dao, "add_registered_key", add, ONE_YOCTO)
        .await?;
    assert_eq!(
        enzure_events(&added),
        [(
            "registered_key_added".to_string(),
            json!({ "public_key": key.public_hex(), "model_id": MODEL })
        )]
    );
    let keys: Value = world.view("get_registered_keys", json!({})).await?;
    assert_eq!(
        keys,
        json!([{ "public_key": key.public_hex(), "model_id": MODEL }])
    );

    let removed = world
        .call(
            &world.dao,
            "remove_registered_key",
            remove.clone(),
            ONE_YOCTO,
        )
        .await?;
    assert_eq!(
        enzure_events(&removed),
        [(
            "registered_key_removed".to_string(),
            json!({ "public_key": key.public_hex(), "model_id": MODEL })
        )]
    );
    let keys: Vec<Value> = world.view("get_registered_keys", json!({})).await?;
    assert!(keys.is_empty());
    let again = world
        .call(&world.dao, "remove_registered_key", remove, ONE_YOCTO)
        .await?;
    assert!(failure_message(again).contains("not a Registered Key"));
    Ok(())
}

#[tokio::test]
async fn each_assertion_keeps_the_prompt_template_current_when_it_was_posted() -> TestResult {
    let s = setup().await?;
    let world = &s.world;
    let content = content();
    let first = s.disputed(&content, BOND).await?;
    let first_request = world.ai_request(first, &content).await?;

    world
        .publish_template(template(MODEL, "A stricter judge."))
        .await?;
    let second = s.disputed(&content, BOND).await?;

    assert_eq!(world.assertion(first).await?["prompt_template_version"], 1);
    assert_eq!(world.assertion(second).await?["prompt_template_version"], 2);
    // Publishing version 2 didn't change the request for the first Assertion.
    assert_eq!(world.ai_request(first, &content).await?, first_request);
    assert!(first_request.contains("Judge the claim."));
    let second_request = world.ai_request(second, &content).await?;
    assert!(second_request.contains("A stricter judge."));
    assert!(!second_request.contains("Judge the claim."));
    let older: Value = world
        .view("get_prompt_template", json!({ "version": 1 }))
        .await?;
    assert_eq!(older["system_prompt"], "Judge the claim.");

    // Each request carries its own dispute's seed and the content as data.
    for id in [first, second] {
        let seed = world.assertion(id).await?["dispute"]["seed"].clone();
        let request: Value = serde_json::from_str(&world.ai_request(id, &content).await?)?;
        assert_eq!(request["seed"], seed);
        assert_eq!(request["model"], MODEL);
        assert_eq!(request["temperature"], 0);
        assert_eq!(request["stream"], false);
        let data: Value =
            serde_json::from_str(request["messages"][1]["content"].as_str().unwrap())?;
        assert_eq!(
            data,
            json!({
                "claim": content.claim,
                "asserter_evidence": content.asserter_evidence,
                "disputer_evidence": content.disputer_evidence,
            })
        );
    }
    Ok(())
}

#[tokio::test]
async fn ai_request_rejects_content_that_does_not_match_the_stored_hashes() -> TestResult {
    let s = setup().await?;
    let world = &s.world;
    let content = content();
    let undisputed = world.post_content(&s.asserter, &content, BOND, 600).await?;
    let id = s.disputed(&content, BOND).await?;

    let not_disputed = world.ai_request_error(undisputed, &content).await;
    assert!(not_disputed.contains("not disputed"), "{not_disputed}");

    let mut wrong = content.clone();
    wrong.claim.push('!');
    let rejected = world.ai_request_error(id, &wrong).await;
    assert!(rejected.contains("claim does not match"), "{rejected}");
    let mut missing = content.clone();
    missing.asserter_evidence = None;
    let rejected = world.ai_request_error(id, &missing).await;
    assert!(
        rejected.contains("asserter_evidence does not match"),
        "{rejected}"
    );
    let mut wrong = content.clone();
    wrong.disputer_evidence = Some("other".into());
    let rejected = world.ai_request_error(id, &wrong).await;
    assert!(
        rejected.contains("disputer_evidence does not match"),
        "{rejected}"
    );
    Ok(())
}

#[tokio::test]
async fn submit_ai_verdict_rejects_each_invalid_submission_with_its_own_error() -> TestResult {
    let s = setup().await?;
    let world = &s.world;
    let content = content();
    let id = s.disputed(&content, BOND).await?;
    let request = world.ai_request(id, &content).await?;
    let valid = Submission::signed(&s.key, MODEL, &request, &verdict_response("chat-1", "TRUE"));

    let reject = |content: Content, submission: Submission, expected: &'static str| {
        let world = &s.world;
        let resolver = s.resolver.clone();
        async move {
            let result = world
                .submit_verdict(&resolver, id, &content, &submission)
                .await?;
            let message = failure_message(result);
            assert!(
                message.contains(expected),
                "expected {expected:?}, got {message}"
            );
            TestResult::Ok(())
        }
    };

    // Content whose sha256 doesn't match the stored hash.
    let mut wrong = content.clone();
    wrong.claim = "Another claim.".into();
    reject(
        wrong,
        valid.clone(),
        "claim does not match the Assertion's claim_hash",
    )
    .await?;
    let mut wrong = content.clone();
    wrong.asserter_evidence = Some("forged".into());
    reject(wrong, valid.clone(), "asserter_evidence does not match").await?;
    let mut wrong = content.clone();
    wrong.disputer_evidence = None;
    reject(wrong, valid.clone(), "disputer_evidence does not match").await?;

    // A response whose verdict isn't exactly TRUE, FALSE or UNRESOLVABLE, even
    // when it is properly signed.
    for body in [
        verdict_response("chat-2", "MAYBE"),
        verdict_response("chat-3", "true"),
        completion("chat-4", r#"{"verdict":"TRUE","reason":"obvious"}"#),
        completion("chat-5", "TRUE"),
        verdict_response("chat-6", "TRUE").replace("\"stop\"", "\"length\""),
        "not json".to_string(),
    ] {
        let signed = Submission::signed(&s.key, MODEL, &request, &body);
        reject(
            content.clone(),
            signed,
            "response_body must hold exactly one verdict",
        )
        .await?;
    }

    // Signed text that isn't model_id:sha256(request):sha256(response) for the pinned model.
    let other_model = Submission::signed(&s.key, "other/model", &request, &valid.response_body);
    reject(content.clone(), other_model, "signed_text must be model_id").await?;
    let other_request = Submission::signed(&s.key, MODEL, "{}", &valid.response_body);
    reject(
        content.clone(),
        other_request,
        "signed_text must be model_id",
    )
    .await?;
    let mut other_response = valid.clone();
    other_response.response_body = verdict_response("chat-7", "TRUE");
    reject(
        content.clone(),
        other_response,
        "signed_text must be model_id",
    )
    .await?;

    // A signature that doesn't verify against a Registered Key for that model.
    let stranger_key = TestKey::new(9);
    let unregistered = Submission::signed(&stranger_key, MODEL, &request, &valid.response_body);
    reject(
        content.clone(),
        unregistered,
        "not a Registered Key for test/judge-1",
    )
    .await?;
    let other_model_key = TestKey::new(10);
    world.register_key(&other_model_key, "other/model").await?;
    let wrong_model_key =
        Submission::signed(&other_model_key, MODEL, &request, &valid.response_body);
    reject(
        content.clone(),
        wrong_model_key,
        "not a Registered Key for test/judge-1",
    )
    .await?;
    let mut forged = valid.clone();
    forged.signature = stranger_key.sign(&valid.signed_text);
    reject(content.clone(), forged, "signature does not verify").await?;

    // A response already recorded.
    world
        .submit_verdict(&s.resolver, id, &content, &valid)
        .await?
        .assert_success();
    reject(content.clone(), valid.clone(), "already recorded").await?;
    Ok(())
}

/// Lets the DAO shorten the Appeal Window to one minute, so tests can wait it out.
async fn short_appeal_window(world: &World) -> TestResult {
    world
        .call(
            &world.dao,
            "set_config",
            json!({ "config": {
                "min_bond": NearToken::from_near(1),
                "default_liveness": 7200,
                "max_hooks": 4,
                "max_near_hook_gas": near_api::NearGas::from_tgas(50),
                "appeal_window": 60,
                "ai_verdict_deadline": 3600,
                "dao_deadline": 604800,
            } }),
            ONE_YOCTO,
        )
        .await?
        .assert_success();
    Ok(())
}

#[tokio::test]
async fn the_appeal_window_is_24_hours_by_default() -> TestResult {
    let s = setup().await?;
    let content = content();
    let id = s.disputed(&content, BOND).await?;
    s.submit(id, &content, "TRUE").await?.assert_success();
    let assertion = s.world.assertion(id).await?;
    let accepted_at = parse_ns(&assertion["ai_verdicts"][0]["accepted_at_ns"]);
    let window_ends = parse_ns(&assertion["appeal_window_ends_at_ns"]);
    assert_eq!(window_ends - accepted_at, 24 * 60 * 60 * 1_000_000_000);
    Ok(())
}

#[tokio::test]
async fn a_true_ai_verdict_rules_and_settles_after_the_appeal_window() -> TestResult {
    let s = setup().await?;
    let world = &s.world;
    short_appeal_window(world).await?;
    let content = content();
    // An odd bond: the odd yoctoNEAR of the loser's half goes to the winner.
    let bond = BOND.saturating_add(NearToken::from_yoctonear(1));
    let id = s.disputed(&content, bond).await?;

    let accepted = s.submit(id, &content, "TRUE").await?;
    let events = enzure_events(&accepted);
    assert_eq!(accepted.json::<String>()?, "TRUE");
    let assertion = world.assertion(id).await?;
    assert_eq!(assertion["state"], "ruled");
    assert_eq!(assertion["outcome"], Value::Null);
    let verdict = &assertion["ai_verdicts"][0];
    assert_eq!(verdict["verdict"], "TRUE");
    assert_eq!(verdict["public_key"], s.key.public_hex());
    let accepted_at = parse_ns(&verdict["accepted_at_ns"]);
    let window_ends = parse_ns(&assertion["appeal_window_ends_at_ns"]);
    assert_eq!(window_ends - accepted_at, 60 * 1_000_000_000);
    assert_eq!(
        events,
        [(
            "ai_verdict_accepted".to_string(),
            json!({
                "assertion_id": id,
                "verdict": "TRUE",
                "resolver": s.resolver,
                "request_hash": verdict["request_hash"],
                "response_hash": verdict["response_hash"],
                "public_key": s.key.public_hex(),
                "appeal_window_ends_at_ns": assertion["appeal_window_ends_at_ns"],
            })
        )]
    );
    let early = world.settle(&s.resolver, id).await?;
    assert!(failure_message(early).contains("Appeal Window has not ended"));

    // Removing the Registered Key doesn't change the accepted AI Verdict.
    world
        .call(
            &world.dao,
            "remove_registered_key",
            json!({ "public_key": s.key.public_hex() }),
            ONE_YOCTO,
        )
        .await?
        .assert_success();
    assert_eq!(
        world.assertion(id).await?["ai_verdicts"],
        assertion["ai_verdicts"]
    );

    world.advance_clock_to(window_ends).await?;
    let settled = world.settle(&s.resolver, id).await?;
    let events = enzure_events(&settled);
    assert!(settled.json::<bool>()?);
    let half = NearToken::from_yoctonear(bond.as_yoctonear() / 2);
    let winner_gets = bond.saturating_add(bond.saturating_sub(half));
    assert_eq!(
        events,
        [(
            "assertion_settled".to_string(),
            json!({
                "assertion_id": id,
                "outcome": true,
                "payouts": [
                    { "account_id": s.asserter, "amount": winner_gets },
                    { "account_id": world.dao, "amount": half },
                ],
            })
        )]
    );
    assert_eq!(world.oracle_balance_of(&s.asserter).await?, winner_gets);
    assert_eq!(world.oracle_balance_of(&world.dao).await?, half);
    assert_eq!(
        world.oracle_balance_of(&s.disputer).await?,
        NearToken::from_yoctonear(0)
    );
    let assertion = world.assertion(id).await?;
    assert_eq!(assertion["state"], "settled");
    assert_eq!(assertion["outcome"], true);
    let outcome: Option<bool> = world
        .view("get_outcome", json!({ "assertion_id": id }))
        .await?;
    assert_eq!(outcome, Some(true));
    let again = world.settle(&s.resolver, id).await?;
    assert!(failure_message(again).contains("already settled"));
    Ok(())
}

#[tokio::test]
async fn a_false_ai_verdict_pays_the_disputer_after_the_configured_appeal_window() -> TestResult {
    let s = setup().await?;
    let world = &s.world;
    short_appeal_window(world).await?;
    let content = Content::new("The sky is green.", None, None);
    let bond = NearToken::from_near(2);
    let id = s.disputed(&content, bond).await?;

    let accepted = s.submit(id, &content, "FALSE").await?;
    assert_eq!(accepted.json::<String>()?, "FALSE");
    let assertion = world.assertion(id).await?;
    let accepted_at = parse_ns(&assertion["ai_verdicts"][0]["accepted_at_ns"]);
    let window_ends = parse_ns(&assertion["appeal_window_ends_at_ns"]);
    assert_eq!(window_ends - accepted_at, 60 * 1_000_000_000);

    world.advance_clock_to(window_ends).await?;
    // Anyone can settle.
    let settled = world.settle(&s.asserter, id).await?;
    assert!(!settled.json::<bool>()?);
    assert_eq!(
        world.oracle_balance_of(&s.disputer).await?,
        NearToken::from_near(3)
    );
    assert_eq!(
        world.oracle_balance_of(&world.dao).await?,
        NearToken::from_near(1)
    );
    assert_eq!(
        world.oracle_balance_of(&s.asserter).await?,
        NearToken::from_yoctonear(0)
    );

    // The Disputer withdraws the winnings.
    let before = world.near_balance(&s.disputer).await?;
    world
        .call(&s.disputer, "withdraw", json!({}), ONE_YOCTO)
        .await?
        .assert_success();
    let gained = world
        .near_balance(&s.disputer)
        .await?
        .saturating_sub(before);
    assert!(
        gained > NearToken::from_near(3).saturating_sub(GAS_SLACK),
        "gained {gained}"
    );
    Ok(())
}

#[tokio::test]
async fn claim_and_evidence_bytes_are_never_stored_and_the_dispute_deposit_covers_storage()
-> TestResult {
    let s = setup().await?;
    let world = &s.world;
    short_appeal_window(world).await?;
    // The longest account id a Disputer can have: 64 characters.
    let long_name = "d".repeat(64 - ".sandbox".len());
    let disputer = world.create_account(&long_name).await?;
    let filler = "x".repeat(20_000);
    let content = Content::new(
        &format!("Claim {filler}"),
        Some(&format!("Asserter's Evidence {filler}")),
        Some(&format!("Disputer's Evidence {filler}")),
    );
    let id = world.post_content(&s.asserter, &content, BOND, 600).await?;

    let storage = world.dispute_storage_deposit().await?;
    let byte_cost = NearToken::from_yoctonear(10u128.pow(19));
    let used_before = world.storage_usage(&world.oracle).await?;
    world.dispute_ok(&disputer, id, &content, BOND).await?;
    s.submit(id, &content, "FALSE").await?.assert_success();
    let used = world.storage_usage(&world.oracle).await? - used_before;
    assert!(
        byte_cost.saturating_mul(used.into()) <= storage,
        "a dispute and AI Verdict used {used} bytes, more than the deposit pays for"
    );

    // Settling credits balances for the Disputer and the DAO; still covered.
    world
        .advance_clock_to(parse_ns(
            &world.assertion(id).await?["appeal_window_ends_at_ns"],
        ))
        .await?;
    world.settle(&s.resolver, id).await?.assert_success();
    let used = world.storage_usage(&world.oracle).await? - used_before;
    assert!(
        byte_cost.saturating_mul(used.into()) <= storage,
        "{used} bytes after settling"
    );
    // Far below the 60 KB of content, which never entered state.
    assert!(used < 1_000, "{used} bytes");
    Ok(())
}

/// A disputed Assertion's Hooks get the AI Verdict's outcome: settling it calls
/// the NEAR Consumer and lets anyone sign the EVM Hook.
#[tokio::test]
async fn settling_a_ruled_assertion_delivers_near_hooks_and_allows_evm_hook_signing() -> TestResult
{
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
    short_appeal_window(world).await?;
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
    let used_before = world.storage_usage(&world.oracle).await?;
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
        .submit_signed_verdict(&resolver, id, &content, &key, "FALSE")
        .await?
        .assert_success();
    let assertion = world.assertion(id).await?;
    assert_eq!(assertion["state"], "ruled");
    assert_eq!(assertion["hooks"][0]["near"]["status"], "pending");
    let early = evm.sign_hook(&resolver, id, 1, ONE_YOCTO).await?;
    assert!(failure_message(early).contains("not settled"));

    world
        .advance_clock_to(parse_ns(&assertion["appeal_window_ends_at_ns"]))
        .await?;
    let settled = world.settle(&resolver, id).await?;
    let half = NearToken::from_yoctonear(BOND.as_yoctonear() / 2);
    assert_eq!(
        enzure_events(&settled),
        [
            (
                "assertion_settled".to_string(),
                json!({
                    "assertion_id": id,
                    "outcome": false,
                    "payouts": [
                        { "account_id": disputer, "amount": BOND.saturating_add(half) },
                        { "account_id": world.dao, "amount": half },
                    ],
                }),
            ),
            (
                "near_hook_delivered".to_string(),
                json!({ "assertion_id": id, "hook_index": 0, "consumer": consumer }),
            ),
        ]
    );
    let recorded: Option<bool> = world
        .view_contract(&consumer, "get_outcome", json!({ "assertion_id": id }))
        .await?;
    assert_eq!(recorded, Some(false));

    let signed = evm.sign_hook(&resolver, id, 1, ONE_YOCTO).await?;
    assert!(signed.json::<bool>()?);
    let result = evm.signed_result(id, 1).await?;
    assert_eq!(result["outcome"], false);
    assert_eq!(result["assertion_id"], id);

    // The Assertion, its Hooks, the dispute and both payouts fit what was paid.
    let used = world.storage_usage(&world.oracle).await? - used_before;
    let paid = world
        .storage_deposit_for(2)
        .await?
        .saturating_add(world.dispute_storage_deposit().await?);
    let byte_cost = NearToken::from_yoctonear(10u128.pow(19));
    assert!(
        byte_cost.saturating_mul(used.into()) <= paid,
        "{used} bytes, more than the deposits pay for"
    );
    Ok(())
}
