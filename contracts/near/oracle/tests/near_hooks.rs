//! NEAR Hooks: a settled Assertion's outcome is delivered to NEAR Consumers.
mod common;

use common::*;
use near_api::{AccountId, NearGas, NearToken};
use serde_json::{Value, json};

const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);

fn near_hook(consumer: &AccountId, tgas: u64) -> Value {
    json!({ "near": { "consumer": consumer, "gas": NearGas::from_tgas(tgas) } })
}

async fn example_consumer(world: &World, name: &str) -> TestResult<AccountId> {
    world
        .deploy(
            name,
            example_near_consumer_wasm(),
            Some(("new", json!({ "oracle": world.oracle }))),
        )
        .await
}

async fn switchable_consumer(world: &World, name: &str, failing: bool) -> TestResult<AccountId> {
    let consumer = world.deploy(name, switchable_consumer_wasm(), None).await?;
    world
        .call_contract(
            &consumer,
            &consumer,
            "set_failing",
            json!({ "failing": failing }),
            NO_DEPOSIT,
        )
        .await?
        .assert_success();
    Ok(consumer)
}

async fn hook_statuses(world: &World, id: u64) -> TestResult<Vec<Value>> {
    let assertion = world.assertion(id).await?;
    Ok(assertion["hooks"]
        .as_array()
        .expect("hooks list")
        .iter()
        .map(|hook| hook["near"]["status"].clone())
        .collect())
}

async fn retry(
    world: &World,
    caller: &AccountId,
    id: u64,
    hook_index: u32,
) -> TestResult<near_api::types::transaction::result::ExecutionFinalResult> {
    world
        .call(
            caller,
            "retry_near_hook",
            json!({ "assertion_id": id, "hook_index": hook_index }),
            NO_DEPOSIT,
        )
        .await
}

#[tokio::test]
async fn a_near_consumer_receives_the_outcome_when_the_assertion_settles() -> TestResult {
    let world = World::new().await?;
    let asserter = world.create_account("asserter").await?;
    let settler = world.create_account("settler").await?;
    let consumer = example_consumer(&world, "consumer").await?;
    let bond = NearToken::from_near(1);

    let id: u64 = world
        .post_with_hooks(&asserter, bond, json!([near_hook(&consumer, 20)]))
        .await?
        .json()?;
    assert_eq!(
        world.assertion(id).await?["hooks"],
        json!([{ "near": {
            "consumer": consumer,
            "gas": NearGas::from_tgas(20),
            "status": "pending",
        } }])
    );

    world.wait_for_liveness(id).await?;
    let settled = world.settle(&settler, id).await?;
    assert!(settled.clone().json::<bool>()?);
    assert_eq!(
        enzure_events(&settled),
        [
            (
                "assertion_settled".to_string(),
                json!({
                    "assertion_id": id,
                    "outcome": true,
                    "payouts": [{ "account_id": asserter, "amount": bond }],
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
    assert_eq!(recorded, Some(true));
    assert_eq!(hook_statuses(&world, id).await?, [json!("delivered")]);
    assert_eq!(world.oracle_balance_of(&asserter).await?, bond);

    // A delivered Hook can't be retried.
    let again = retry(&world, &settler, id, 0).await?;
    assert!(failure_message(again).contains("already delivered"));
    Ok(())
}

#[tokio::test]
async fn the_example_consumer_accepts_only_the_oracle_and_ignores_repeats() -> TestResult {
    let world = World::new().await?;
    let asserter = world.create_account("asserter").await?;
    let consumer = example_consumer(&world, "consumer").await?;

    let forged = world
        .call_contract(
            &asserter,
            &consumer,
            "assertion_resolved",
            json!({ "assertion_id": 1, "truthful": false }),
            NO_DEPOSIT,
        )
        .await?;
    assert!(failure_message(forged).contains("Only the oracle"));

    let id: u64 = world
        .post_with_hooks(
            &asserter,
            NearToken::from_near(1),
            json!([near_hook(&consumer, 20)]),
        )
        .await?
        .json()?;
    world.wait_for_liveness(id).await?;
    world.settle(&asserter, id).await?.assert_success();

    // A repeated call from the oracle account changes nothing.
    world
        .call_contract(
            &world.oracle,
            &consumer,
            "assertion_resolved",
            json!({ "assertion_id": id, "truthful": false }),
            NO_DEPOSIT,
        )
        .await?
        .assert_success();
    let recorded: Option<bool> = world
        .view_contract(&consumer, "get_outcome", json!({ "assertion_id": id }))
        .await?;
    assert_eq!(recorded, Some(true));
    Ok(())
}

#[tokio::test]
async fn a_failing_consumer_leaves_the_assertion_settled_and_anyone_can_retry() -> TestResult {
    let world = World::new().await?;
    let asserter = world.create_account("asserter").await?;
    let stranger = world.create_account("stranger").await?;
    let consumer = switchable_consumer(&world, "consumer", true).await?;
    let delivered = example_consumer(&world, "delivered").await?;
    let bond = NearToken::from_near(1);

    let id: u64 = world
        .post_with_hooks(
            &asserter,
            bond,
            json!([near_hook(&consumer, 25), near_hook(&delivered, 20)]),
        )
        .await?
        .json()?;
    world.wait_for_liveness(id).await?;
    let settled = world.settle(&stranger, id).await?;
    settled.clone().assert_success();
    let events = enzure_events(&settled);
    assert!(events.contains(&(
        "near_hook_failed".to_string(),
        json!({ "assertion_id": id, "hook_index": 0, "consumer": consumer }),
    )));
    assert!(events.contains(&(
        "near_hook_delivered".to_string(),
        json!({ "assertion_id": id, "hook_index": 1, "consumer": delivered }),
    )));

    // The Assertion stays settled and the bond stays credited.
    let assertion = world.assertion(id).await?;
    assert_eq!(assertion["state"], "settled");
    assert_eq!(assertion["outcome"], true);
    assert_eq!(world.oracle_balance_of(&asserter).await?, bond);
    assert_eq!(
        hook_statuses(&world, id).await?,
        [json!("failed"), json!("delivered")]
    );

    // Retrying while the Consumer still fails records another failure.
    let still_failing = retry(&world, &stranger, id, 0).await?;
    assert_eq!(
        enzure_events(&still_failing),
        [(
            "near_hook_failed".to_string(),
            json!({ "assertion_id": id, "hook_index": 0, "consumer": consumer }),
        )]
    );
    assert_eq!(hook_statuses(&world, id).await?[0], "failed");

    // Once the Consumer is fixed, anyone's retry delivers it with the fixed gas.
    world
        .call_contract(
            &consumer,
            &consumer,
            "set_failing",
            json!({ "failing": false }),
            NO_DEPOSIT,
        )
        .await?
        .assert_success();
    let retried = retry(&world, &stranger, id, 0).await?;
    assert_eq!(
        enzure_events(&retried),
        [(
            "near_hook_delivered".to_string(),
            json!({ "assertion_id": id, "hook_index": 0, "consumer": consumer }),
        )]
    );
    let deliveries: Value = world
        .view_contract(&consumer, "get_deliveries", json!({}))
        .await?;
    assert_eq!(
        deliveries,
        json!([{
            "assertion_id": id,
            "truthful": true,
            "prepaid_gas": NearGas::from_tgas(25).as_gas().to_string(),
        }])
    );
    assert_eq!(
        hook_statuses(&world, id).await?,
        [json!("delivered"), json!("delivered")]
    );

    let again = retry(&world, &stranger, id, 0).await?;
    assert!(failure_message(again).contains("already delivered"));
    let missing = retry(&world, &stranger, id, 2).await?;
    assert!(failure_message(missing).contains("no Hook 2"));
    Ok(())
}

#[tokio::test]
async fn hooks_can_only_be_retried_after_settlement() -> TestResult {
    let world = World::new().await?;
    let asserter = world.create_account("asserter").await?;
    let consumer = switchable_consumer(&world, "consumer", false).await?;
    let id: u64 = world
        .post_with_hooks(
            &asserter,
            NearToken::from_near(1),
            json!([near_hook(&consumer, 20)]),
        )
        .await?
        .json()?;
    let early = retry(&world, &asserter, id, 0).await?;
    assert!(failure_message(early).contains("not settled"));
    Ok(())
}

#[tokio::test]
async fn settle_is_rejected_without_enough_gas_for_every_near_hook() -> TestResult {
    let world = World::new().await?;
    let asserter = world.create_account("asserter").await?;
    let first = switchable_consumer(&world, "first", false).await?;
    let second = switchable_consumer(&world, "second", false).await?;
    let id: u64 = world
        .post_with_hooks(
            &asserter,
            NearToken::from_near(1),
            json!([near_hook(&first, 50), near_hook(&second, 50)]),
        )
        .await?
        .json()?;
    world.wait_for_liveness(id).await?;

    let starved = world
        .settle_with_gas(&asserter, id, NearGas::from_tgas(100))
        .await?;
    assert!(failure_message(starved).contains("Attach at least"));
    let assertion = world.assertion(id).await?;
    assert_eq!(assertion["state"], "asserted");
    assert_eq!(
        world.oracle_balance_of(&asserter).await?,
        NearToken::from_yoctonear(0)
    );

    world
        .settle_with_gas(&asserter, id, NearGas::from_tgas(300))
        .await?
        .assert_success();
    assert_eq!(
        hook_statuses(&world, id).await?,
        [json!("delivered"), json!("delivered")]
    );
    Ok(())
}

#[tokio::test]
async fn posting_hooks_is_limited_by_the_config_and_the_asserter_pays_their_storage() -> TestResult
{
    let world = World::new().await?;
    let config: Value = world.view("get_config", json!({})).await?;
    assert_eq!(config["max_hooks"], 4);
    assert_eq!(config["max_near_hook_gas"], json!(NearGas::from_tgas(50)));

    // The longest account ids: 64 characters.
    let long = |prefix: &str| {
        format!(
            "{prefix}{}",
            "a".repeat(64 - ".sandbox".len() - prefix.len())
        )
    };
    let asserter = world.create_account(&long("asserter")).await?;
    let consumer = world.create_account(&long("consumer")).await?;
    let bond = NearToken::from_near(1);
    let one_hook = world.storage_deposit_for(1).await?;
    assert!(one_hook > world.storage_deposit().await?);

    let post = |hooks: Value, deposit: NearToken| {
        let world = &world;
        let asserter = &asserter;
        async move {
            world
                .call(
                    asserter,
                    "assert_claim",
                    json!({
                        "claim_hash": CLAIM_HASH,
                        "bond": bond,
                        "liveness": 60,
                        "hooks": hooks,
                    }),
                    deposit,
                )
                .await
        }
    };
    let too_many = post(
        json!(vec![near_hook(&consumer, 10); 5]),
        bond.saturating_add(world.storage_deposit_for(5).await?),
    )
    .await?;
    assert!(failure_message(too_many).contains("At most 4 Hooks"));
    let too_much_gas = post(
        json!([near_hook(&consumer, 51)]),
        bond.saturating_add(one_hook),
    )
    .await?;
    assert!(failure_message(too_much_gas).contains("gas must be between"));
    let no_gas = post(
        json!([{ "near": { "consumer": consumer, "gas": "0" } }]),
        bond.saturating_add(one_hook),
    )
    .await?;
    assert!(failure_message(no_gas).contains("gas must be between"));
    let unpaid = post(
        json!([near_hook(&consumer, 10)]),
        bond.saturating_add(world.storage_deposit().await?),
    )
    .await?;
    assert!(failure_message(unpaid).contains("Attach the bond plus the storage deposit"));

    // Four Hooks with the longest Consumer id and the most gas fit the deposit,
    // including the balance entry settlement adds.
    let used_before = world.storage_usage(&world.oracle).await?;
    let storage = world.storage_deposit_for(4).await?;
    let id: u64 = post(
        json!(vec![near_hook(&consumer, 50); 4]),
        bond.saturating_add(storage),
    )
    .await?
    .json()?;
    world.wait_for_liveness(id).await?;
    world.settle(&asserter, id).await?.assert_success();
    let used = world.storage_usage(&world.oracle).await? - used_before;
    let byte_cost = NearToken::from_yoctonear(10u128.pow(19));
    assert!(
        byte_cost.saturating_mul(used.into()) <= storage,
        "an Assertion with 4 Hooks used {used} bytes, more than the deposit pays for"
    );
    Ok(())
}

#[tokio::test]
async fn the_storage_deposit_grows_with_each_hook() -> TestResult {
    let world = World::new().await?;
    let asserter = world.create_account("asserter").await?;
    let consumer = switchable_consumer(&world, "consumer", false).await?;
    // 500 bytes for the Assertion plus 200 per Hook, at 10^19 yoctoNEAR a byte.
    let byte_cost = NearToken::from_yoctonear(10u128.pow(19));
    for hooks in 0..=4u32 {
        assert_eq!(
            world.storage_deposit_for(hooks).await?,
            byte_cost.saturating_mul(u128::from(500 + 200 * hooks)),
            "deposit for {hooks} Hooks"
        );
    }

    // Paying for one Hook doesn't cover two.
    let bond = NearToken::from_near(1);
    let underpaid = world
        .call(
            &asserter,
            "assert_claim",
            json!({
                "claim_hash": CLAIM_HASH,
                "bond": bond,
                "liveness": 60,
                "hooks": [near_hook(&consumer, 10), near_hook(&consumer, 10)],
            }),
            bond.saturating_add(world.storage_deposit_for(1).await?),
        )
        .await?;
    assert!(failure_message(underpaid).contains("Attach the bond plus the storage deposit"));
    Ok(())
}

#[tokio::test]
async fn the_dao_sets_the_hook_limits() -> TestResult {
    let world = World::new().await?;
    let asserter = world.create_account("asserter").await?;
    let consumer = switchable_consumer(&world, "consumer", false).await?;
    let changed = world
        .call(
            &world.dao,
            "set_config",
            json!({ "config": {
                "min_bond": NearToken::from_near(1),
                "default_liveness": 7200,
                "max_hooks": 1,
                "max_near_hook_gas": NearGas::from_tgas(100),
                "appeal_window": 86400,
                "ai_verdict_deadline": 3600,
                "dao_deadline": 604800,
            } }),
            ONE_YOCTO,
        )
        .await?;
    assert_eq!(
        enzure_events(&changed),
        [(
            "config_changed".to_string(),
            json!({
                "min_bond": NearToken::from_near(1),
                "default_liveness": 7200,
                "max_hooks": 1,
                "max_near_hook_gas": NearGas::from_tgas(100),
                "appeal_window": 86400,
                "ai_verdict_deadline": 3600,
                "dao_deadline": 604800,
            }),
        )]
    );

    let bond = NearToken::from_near(1);
    let two = world
        .post_with_hooks(
            &asserter,
            bond,
            json!([near_hook(&consumer, 10), near_hook(&consumer, 10)]),
        )
        .await?;
    assert!(failure_message(two).contains("At most 1 Hooks"));
    world
        .post_with_hooks(&asserter, bond, json!([near_hook(&consumer, 100)]))
        .await?
        .assert_success();
    Ok(())
}

/// `settle` needs Σ(Hook gas + 15 TGas) + 20 TGas, and a transaction carries
/// at most 300 TGas, so the DAO can't allow Hooks no settlement could carry.
#[tokio::test]
async fn the_dao_cant_allow_more_hook_gas_than_a_settlement_can_carry() -> TestResult {
    let world = World::new().await?;
    let set_limits = |max_hooks: u32, tgas: u64| {
        let world = &world;
        async move {
            world
                .call(
                    &world.dao,
                    "set_config",
                    json!({ "config": {
                        "min_bond": NearToken::from_near(1),
                        "default_liveness": 7200,
                        "max_hooks": max_hooks,
                        "max_near_hook_gas": NearGas::from_tgas(tgas),
                        "appeal_window": 86400,
                        "ai_verdict_deadline": 3600,
                        "dao_deadline": 604800,
                    } }),
                    ONE_YOCTO,
                )
                .await
        }
    };
    // 4 × (50 + 15) + 20 = 280 TGas: the defaults, the most allowed.
    set_limits(4, 50).await?.assert_success();
    set_limits(1, 245).await?.assert_success();
    for (max_hooks, tgas) in [(4, 51), (5, 50), (1, 246), (100, 1)] {
        let rejected = set_limits(max_hooks, tgas).await?;
        assert!(
            failure_message(rejected).contains("must fit in 280000000000000 gas"),
            "{max_hooks} Hooks of {tgas} TGas"
        );
    }
    // No Hooks at all need no gas, whatever the per-Hook limit.
    set_limits(0, 1000).await?.assert_success();
    assert_eq!(
        world.view::<Value>("get_config", json!({})).await?["max_hooks"],
        0
    );
    Ok(())
}
