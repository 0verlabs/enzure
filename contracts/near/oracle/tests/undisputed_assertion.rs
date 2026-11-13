//! An Assertion nobody disputes: posting, settlement after Liveness, and withdrawal.
mod common;

use common::*;
use near_api::NearToken;

#[tokio::test]
async fn posting_returns_sequential_ids_and_the_assertion_is_readable() -> TestResult {
    let world = World::new().await?;
    let asserter = world.create_account("asserter").await?;
    let bond = NearToken::from_near(2);

    let before = world.now_ns().await?;
    let first = world.post_ok(&asserter, bond, Some(600)).await?;
    let second = world.post_ok(&asserter, bond, None).await?;
    assert_eq!((first, second), (1, 2));

    let assertion = world.assertion(first).await?;
    assert_eq!(assertion["id"], 1);
    assert_eq!(assertion["asserter"], asserter.as_str());
    assert_eq!(assertion["claim_hash"], CLAIM_HASH);
    assert_eq!(assertion["evidence_hash"], EVIDENCE_HASH);
    assert_eq!(assertion["bond"], bond.as_yoctonear().to_string());
    assert_eq!(assertion["state"], "asserted");
    assert!(assertion["outcome"].is_null());

    let asserted_at = parse_ns(&assertion["asserted_at_ns"]);
    assert!(asserted_at >= before);
    assert_eq!(
        parse_ns(&assertion["liveness_ends_at_ns"]) - asserted_at,
        600 * 1_000_000_000
    );

    // Without a Liveness, the configured default of 2 hours applies.
    let second = world.assertion(second).await?;
    assert_eq!(
        parse_ns(&second["liveness_ends_at_ns"]) - parse_ns(&second["asserted_at_ns"]),
        2 * 60 * 60 * 1_000_000_000
    );

    // Evidence is optional.
    let storage = world.storage_deposit().await?;
    let without_evidence = world
        .call(
            &asserter,
            "assert_claim",
            post_args(bond, None),
            bond.saturating_add(storage),
        )
        .await?;
    let third: u64 = without_evidence.json()?;
    assert_eq!(third, 3);
    let third = world.assertion(third).await?;
    assert_eq!(third["claim_hash"], CLAIM_HASH);
    assert!(third["evidence_hash"].is_null());
    Ok(())
}

/// Posts with explicit arguments and deposit, asserting the call fails with
/// `expected` in its message and that the Asserter only paid gas.
async fn assert_rejected(
    world: &World,
    asserter: &near_api::AccountId,
    args: serde_json::Value,
    deposit: NearToken,
    expected: &str,
) -> TestResult {
    let before = world.near_balance(asserter).await?;
    let result = world.call(asserter, "assert_claim", args, deposit).await?;
    let message = failure_message(result);
    assert!(
        message.contains(expected),
        "{message} should mention {expected:?}"
    );
    let spent = before.saturating_sub(world.near_balance(asserter).await?);
    assert!(
        spent < NearToken::from_millinear(10),
        "deposit kept: spent {spent}"
    );
    Ok(())
}

/// Arguments for `assert_claim` without Evidence.
fn post_args(bond: NearToken, liveness: Option<u64>) -> serde_json::Value {
    serde_json::json!({
        "claim_hash": CLAIM_HASH,
        "bond": bond,
        "liveness": liveness,
        "hooks": [],
    })
}

#[tokio::test]
async fn posting_is_rejected_and_refunded_when_the_terms_are_wrong() -> TestResult {
    let world = World::new().await?;
    let asserter = world.create_account("asserter").await?;
    let storage = world.storage_deposit().await?;
    let one = NearToken::from_near(1);
    let enough = |bond: NearToken| bond.saturating_add(storage);

    let below_minimum = one.saturating_sub(ONE_YOCTO);
    assert_rejected(
        &world,
        &asserter,
        post_args(below_minimum, None),
        enough(one),
        "Bond must be at least",
    )
    .await?;
    assert_rejected(
        &world,
        &asserter,
        post_args(one, Some(59)),
        enough(one),
        "Liveness must be between",
    )
    .await?;
    assert_rejected(
        &world,
        &asserter,
        post_args(one, Some(604_801)),
        enough(one),
        "Liveness must be between",
    )
    .await?;
    assert_rejected(
        &world,
        &asserter,
        post_args(one, None),
        enough(one).saturating_sub(ONE_YOCTO),
        "Attach the bond plus the storage deposit",
    )
    .await?;
    let bad_hash = serde_json::json!({ "claim_hash": "not-a-hash", "bond": one, "hooks": [] });
    assert_rejected(
        &world,
        &asserter,
        bad_hash,
        enough(one),
        "claim_hash must be a sha256 hash",
    )
    .await?;

    // The limits themselves are allowed.
    world.post_ok(&asserter, one, Some(60)).await?;
    world.post_ok(&asserter, one, Some(604_800)).await?;
    Ok(())
}

#[tokio::test]
async fn the_storage_deposit_covers_an_assertion_and_extra_deposit_is_refunded() -> TestResult {
    let world = World::new().await?;
    // The longest account id an Asserter can have: 64 characters.
    let long_name = "a".repeat(64 - ".sandbox".len());
    let asserter = world.create_account(&long_name).await?;
    let storage = world.storage_deposit().await?;
    assert!(storage > NearToken::from_yoctonear(0));

    let used_before = world.storage_usage(&world.oracle).await?;
    let balance_before = world.near_balance(&asserter).await?;
    let bond = NearToken::from_near(1);
    let extra = NearToken::from_near(3);
    let result = world
        .call(
            &asserter,
            "assert_claim",
            serde_json::json!({
                "claim_hash": CLAIM_HASH,
                "evidence_hash": EVIDENCE_HASH,
                "bond": bond,
                "liveness": 60,
                "hooks": [],
            }),
            bond.saturating_add(storage).saturating_add(extra),
        )
        .await?;
    let id: u64 = result.json()?;

    let used = world.storage_usage(&world.oracle).await? - used_before;
    let byte_cost = NearToken::from_yoctonear(10u128.pow(19));
    assert!(
        byte_cost.saturating_mul(used.into()) <= storage,
        "an Assertion used {used} bytes, more than the deposit pays for"
    );

    // Only the bond and the storage deposit were kept.
    let spent = balance_before.saturating_sub(world.near_balance(&asserter).await?);
    let kept = bond.saturating_add(storage);
    assert!(
        spent >= kept && spent < kept.saturating_add(NearToken::from_millinear(10)),
        "spent {spent}"
    );

    // Settling credits a balance entry; the deposit pays for that too.
    world
        .advance_clock_to(parse_ns(&world.assertion(id).await?["liveness_ends_at_ns"]))
        .await?;
    world.settle(&asserter, id).await?.assert_success();
    let used = world.storage_usage(&world.oracle).await? - used_before;
    assert!(
        byte_cost.saturating_mul(used.into()) <= storage,
        "{used} bytes after settling"
    );
    Ok(())
}

fn parse_ns(value: &serde_json::Value) -> u64 {
    value
        .as_str()
        .expect("timestamp string")
        .parse()
        .expect("timestamp")
}

#[tokio::test]
async fn an_undisputed_assertion_settles_true_only_after_liveness_and_anyone_can_settle_it()
-> TestResult {
    let world = World::new().await?;
    let asserter = world.create_account("asserter").await?;
    let stranger = world.create_account("stranger").await?;
    let bond = NearToken::from_near(2);
    let id = world.post_ok(&asserter, bond, Some(60)).await?;
    let no_deposit = NearToken::from_yoctonear(0);

    let early = world.settle(&stranger, id).await?;
    assert!(failure_message(early).contains("Liveness has not ended"));
    let outcome: Option<bool> = world
        .view("get_outcome", serde_json::json!({ "assertion_id": id }))
        .await?;
    assert_eq!(outcome, None);
    assert_eq!(world.oracle_balance_of(&asserter).await?, no_deposit);

    let liveness_ends_at = parse_ns(&world.assertion(id).await?["liveness_ends_at_ns"]);
    world.advance_clock_to(liveness_ends_at).await?;
    let settled = world.settle(&stranger, id).await?;
    let outcome: bool = settled.json()?;
    assert!(outcome);

    let assertion = world.assertion(id).await?;
    assert_eq!(assertion["state"], "settled");
    assert_eq!(assertion["outcome"], true);
    assert!(parse_ns(&assertion["settled_at_ns"]) >= liveness_ends_at);
    let outcome: Option<bool> = world
        .view("get_outcome", serde_json::json!({ "assertion_id": id }))
        .await?;
    assert_eq!(outcome, Some(true));

    // The whole bond is credited to the Asserter, and only once.
    assert_eq!(world.oracle_balance_of(&asserter).await?, bond);
    let again = world.settle(&stranger, id).await?;
    assert!(failure_message(again).contains("already settled"));
    assert_eq!(world.oracle_balance_of(&asserter).await?, bond);
    assert_eq!(world.oracle_balance_of(&stranger).await?, no_deposit);
    Ok(())
}

/// Posts an Assertion with a one-minute Liveness and settles it, so the Asserter
/// has `bond` to withdraw.
async fn post_and_settle(
    world: &World,
    asserter: &near_api::AccountId,
    bond: NearToken,
) -> TestResult<u64> {
    let id = world.post_ok(asserter, bond, Some(60)).await?;
    world
        .advance_clock_to(parse_ns(&world.assertion(id).await?["liveness_ends_at_ns"]))
        .await?;
    world.settle(asserter, id).await?.assert_success();
    Ok(id)
}

#[tokio::test]
async fn the_asserter_withdraws_the_bond_with_one_yocto() -> TestResult {
    let world = World::new().await?;
    let asserter = world.create_account("asserter").await?;
    let bond = NearToken::from_near(3);
    post_and_settle(&world, &asserter, bond).await?;

    // A limited access key can't attach a deposit, so one yoctoNEAR is required.
    for deposit in [NearToken::from_yoctonear(0), NearToken::from_yoctonear(2)] {
        let result = world
            .call(&asserter, "withdraw", serde_json::json!({}), deposit)
            .await?;
        assert!(
            failure_message(result).contains("Requires attached deposit of exactly 1 yoctoNEAR")
        );
    }
    let too_much = world
        .call(
            &asserter,
            "withdraw",
            serde_json::json!({ "amount": bond.saturating_add(ONE_YOCTO) }),
            ONE_YOCTO,
        )
        .await?;
    assert!(failure_message(too_much).contains("exceeds the balance"));
    assert_eq!(world.oracle_balance_of(&asserter).await?, bond);

    // Part of the balance, then the rest.
    let before = world.near_balance(&asserter).await?;
    let part = NearToken::from_near(1);
    world
        .call(
            &asserter,
            "withdraw",
            serde_json::json!({ "amount": part }),
            ONE_YOCTO,
        )
        .await?
        .assert_success();
    assert_eq!(
        world.oracle_balance_of(&asserter).await?,
        bond.saturating_sub(part)
    );
    let rest = world
        .call(&asserter, "withdraw", serde_json::json!({}), ONE_YOCTO)
        .await?;
    let sent: bool = rest.json()?;
    assert!(sent);
    assert_eq!(
        world.oracle_balance_of(&asserter).await?,
        NearToken::from_yoctonear(0)
    );

    let gained = world.near_balance(&asserter).await?.saturating_sub(before);
    assert!(
        gained > bond.saturating_sub(NearToken::from_millinear(10)) && gained <= bond,
        "gained {gained}"
    );

    let empty = world
        .call(&asserter, "withdraw", serde_json::json!({}), ONE_YOCTO)
        .await?;
    assert!(failure_message(empty).contains("Nothing to withdraw"));
    Ok(())
}

#[tokio::test]
async fn a_failed_withdrawal_transfer_leaves_the_balance_intact() -> TestResult {
    let world = World::new().await?;
    let asserter = world.create_account("asserter").await?;
    let beneficiary = world.create_account("beneficiary").await?;
    let bond = NearToken::from_near(2);
    post_and_settle(&world, &asserter, bond).await?;

    // The Asserter's account calls `withdraw` and deletes itself in the same
    // block, so the oracle's transfer arrives at an account that no longer exists.
    near_api::Contract::deploy(asserter.clone())
        .use_code(self_deleting_account_wasm().to_vec())
        .without_init_call()
        .with_signer(world.signer.clone())
        .send_to(&world.network)
        .await?
        .assert_success();
    let result = world
        .call_contract(
            &asserter,
            &asserter,
            "withdraw_and_delete",
            serde_json::json!({ "oracle": world.oracle, "beneficiary": beneficiary }),
            NearToken::from_yoctonear(0),
        )
        .await?;
    assert!(!result.logs().is_empty(), "the oracle's callback ran");

    assert_eq!(world.oracle_balance_of(&asserter).await?, bond);
    let events = enzure_events(&result);
    assert!(
        events.iter().any(|(name, _)| name == "withdrawal_failed"),
        "{events:?}"
    );
    assert!(!events.iter().any(|(name, _)| name == "withdrawal"));
    Ok(())
}

#[tokio::test]
async fn assertions_are_listed_newest_first_a_page_at_a_time() -> TestResult {
    let world = World::new().await?;
    let asserter = world.create_account("asserter").await?;
    let empty: Vec<serde_json::Value> =
        world.view("list_assertions", serde_json::json!({})).await?;
    assert!(empty.is_empty());
    for _ in 0..5 {
        world
            .post_ok(&asserter, NearToken::from_near(1), None)
            .await?;
    }

    let ids = |page: Vec<serde_json::Value>| {
        page.iter()
            .map(|a| a["id"].as_u64().unwrap())
            .collect::<Vec<_>>()
    };
    let all: Vec<serde_json::Value> = world.view("list_assertions", serde_json::json!({})).await?;
    assert_eq!(ids(all), [5, 4, 3, 2, 1]);
    let first: Vec<serde_json::Value> = world
        .view("list_assertions", serde_json::json!({ "limit": 2 }))
        .await?;
    assert_eq!(first[0]["state"], "asserted");
    assert_eq!(ids(first), [5, 4]);
    let next: Vec<serde_json::Value> = world
        .view(
            "list_assertions",
            serde_json::json!({ "before_id": 4, "limit": 2 }),
        )
        .await?;
    assert_eq!(ids(next), [3, 2]);
    let last: Vec<serde_json::Value> = world
        .view(
            "list_assertions",
            serde_json::json!({ "before_id": 2, "limit": 2 }),
        )
        .await?;
    assert_eq!(ids(last), [1]);
    Ok(())
}

#[tokio::test]
async fn posting_settlement_and_withdrawal_emit_enzure_events() -> TestResult {
    let world = World::new().await?;
    let asserter = world.create_account("asserter").await?;
    let bond = NearToken::from_near(1);

    let posted = world.post(&asserter, bond, Some(60)).await?;
    let events = enzure_events(&posted);
    let id: u64 = posted.json()?;
    let assertion = world.assertion(id).await?;
    assert_eq!(
        events,
        [(
            "assertion_posted".to_string(),
            serde_json::json!({
                "assertion_id": id,
                "asserter": asserter,
                "claim_hash": CLAIM_HASH,
                "evidence_hash": EVIDENCE_HASH,
                "bond": bond,
                "liveness_ends_at_ns": assertion["liveness_ends_at_ns"],
            }),
        )]
    );

    world
        .advance_clock_to(parse_ns(&assertion["liveness_ends_at_ns"]))
        .await?;
    let settled = world.settle(&asserter, id).await?;
    assert_eq!(
        enzure_events(&settled),
        [(
            "assertion_settled".to_string(),
            serde_json::json!({
                "assertion_id": id,
                "outcome": true,
                "payouts": [{ "account_id": asserter, "amount": bond }],
            }),
        )]
    );

    let withdrawn = world
        .call(&asserter, "withdraw", serde_json::json!({}), ONE_YOCTO)
        .await?;
    assert_eq!(
        enzure_events(&withdrawn),
        [(
            "withdrawal".to_string(),
            serde_json::json!({ "account_id": asserter, "amount": bond }),
        )]
    );
    Ok(())
}

#[tokio::test]
async fn only_the_dao_changes_the_config() -> TestResult {
    let world = World::new().await?;
    let asserter = world.create_account("asserter").await?;
    let config: serde_json::Value = world.view("get_config", serde_json::json!({})).await?;
    assert_eq!(
        config,
        serde_json::json!({
            "dao": world.dao,
            "min_bond": NearToken::from_near(1),
            "default_liveness": 7200,
            "max_hooks": 4,
            "max_near_hook_gas": near_api::NearGas::from_tgas(50),
            "appeal_window": 86400,
        })
    );

    let hook_gas = near_api::NearGas::from_tgas(50);
    let new_config = serde_json::json!({
        "config": {
            "min_bond": NearToken::from_near(5),
            "default_liveness": 300,
            "max_hooks": 4,
            "max_near_hook_gas": hook_gas,
            "appeal_window": 120,
        }
    });
    let by_stranger = world
        .call(&asserter, "set_config", new_config.clone(), ONE_YOCTO)
        .await?;
    assert!(failure_message(by_stranger).contains("Only the DAO can change the config"));
    let without_yocto = world
        .call(
            &world.dao,
            "set_config",
            new_config.clone(),
            NearToken::from_yoctonear(0),
        )
        .await?;
    assert!(failure_message(without_yocto).contains("exactly 1 yoctoNEAR"));
    let bad_liveness = serde_json::json!({
        "config": {
            "min_bond": NearToken::from_near(5),
            "default_liveness": 30,
            "max_hooks": 4,
            "max_near_hook_gas": hook_gas,
            "appeal_window": 120,
        }
    });
    let rejected = world
        .call(&world.dao, "set_config", bad_liveness, ONE_YOCTO)
        .await?;
    assert!(failure_message(rejected).contains("default_liveness must be between"));

    let changed = world
        .call(&world.dao, "set_config", new_config, ONE_YOCTO)
        .await?;
    assert_eq!(
        enzure_events(&changed),
        [(
            "config_changed".to_string(),
            serde_json::json!({
                "min_bond": NearToken::from_near(5),
                "default_liveness": 300,
                "max_hooks": 4,
                "max_near_hook_gas": hook_gas,
                "appeal_window": 120,
            }),
        )]
    );
    let config: serde_json::Value = world.view("get_config", serde_json::json!({})).await?;
    assert_eq!(
        config["min_bond"],
        serde_json::json!(NearToken::from_near(5))
    );
    assert_eq!(config["default_liveness"], 300);
    assert_eq!(config["appeal_window"], 120);

    // The new settings apply to the next Assertion.
    let small = world.post(&asserter, NearToken::from_near(4), None).await?;
    assert!(failure_message(small).contains("Bond must be at least"));
    let id = world
        .post_ok(&asserter, NearToken::from_near(5), None)
        .await?;
    let assertion = world.assertion(id).await?;
    let liveness =
        parse_ns(&assertion["liveness_ends_at_ns"]) - parse_ns(&assertion["asserted_at_ns"]);
    assert_eq!(liveness, 300 * 1_000_000_000);
    Ok(())
}
