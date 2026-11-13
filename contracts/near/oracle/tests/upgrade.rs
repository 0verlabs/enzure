//! Upgrading the oracle (ADR 0004): new code reaches the oracle account only
//! through its own `upgrade` method, which only the DAO can call, and the state
//! survives. `dao.sandbox` acts as the DAO. The `test-seed` build stands in for
//! "new code": it has one method, `set_test_seed`, the production build lacks.
mod common;

use common::*;
use near_api::{AccountId, NearToken};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);

impl World {
    async fn upgrade(
        &self,
        caller: &AccountId,
        code: &[u8],
        deposit: NearToken,
    ) -> TestResult<near_api::types::transaction::result::ExecutionFinalResult> {
        self.call_raw(caller, "upgrade", code.to_vec(), deposit)
            .await
    }

    /// Whether the deployed code has `set_test_seed`, i.e. is the `test-seed` build.
    async fn runs_test_seed_build(&self) -> TestResult<bool> {
        let result = self
            .call(
                &self.dao.clone(),
                "set_test_seed",
                json!({ "seed": 7 }),
                NO_DEPOSIT,
            )
            .await?;
        if result.is_success() {
            return Ok(true);
        }
        let message = failure_message(result);
        assert!(message.contains("MethodNotFound"), "{message}");
        Ok(false)
    }
}

#[tokio::test]
async fn only_the_dao_can_upgrade_the_oracle_and_only_with_one_yocto() -> TestResult {
    let world = World::new().await?;
    let stranger = world.create_account("stranger").await?;
    let new_code = oracle_test_seed_wasm();

    let by_stranger = world.upgrade(&stranger, new_code, ONE_YOCTO).await?;
    assert!(failure_message(by_stranger).contains("Only the DAO can upgrade the contract"));

    // The oracle itself has no say either: only the DAO.
    let by_oracle = world
        .upgrade(&world.oracle.clone(), new_code, ONE_YOCTO)
        .await?;
    assert!(failure_message(by_oracle).contains("Only the DAO can upgrade the contract"));

    // Without the yoctoNEAR a function-call access key of the DAO could do it.
    let without_yocto = world
        .upgrade(&world.dao.clone(), new_code, NO_DEPOSIT)
        .await?;
    assert!(
        failure_message(without_yocto).contains("Requires attached deposit of exactly 1 yoctoNEAR")
    );

    let no_code = world.upgrade(&world.dao.clone(), &[], ONE_YOCTO).await?;
    assert!(failure_message(no_code).contains("Pass the new code as the call's input"));

    assert!(!world.runs_test_seed_build().await?);
    Ok(())
}

#[tokio::test]
async fn the_dao_upgrades_the_oracle_and_every_assertion_balance_and_setting_survives() -> TestResult
{
    let world = World::new().await?;
    let asserter = world.create_account("asserter").await?;

    // Some state worth keeping: a changed config and a settled Assertion with a
    // balance, plus one still in Liveness.
    let mut config: Value = world.view("get_config", json!({})).await?;
    config.as_object_mut().unwrap().remove("dao");
    config["default_liveness"] = json!(120);
    world
        .call(
            &world.dao.clone(),
            "set_config",
            json!({ "config": config }),
            ONE_YOCTO,
        )
        .await?
        .assert_success();
    let settled = world
        .post_ok(&asserter, NearToken::from_near(1), Some(60))
        .await?;
    world.wait_for_liveness(settled).await?;
    world.settle(&asserter, settled).await?.assert_success();
    let pending = world
        .post_ok(&asserter, NearToken::from_near(2), None)
        .await?;

    let config_before: Value = world.view("get_config", json!({})).await?;
    let settled_before = world.assertion(settled).await?;
    let pending_before = world.assertion(pending).await?;
    let balance_before = world.oracle_balance_of(&asserter).await?;
    assert!(!world.runs_test_seed_build().await?);

    let new_code = oracle_test_seed_wasm();
    let upgraded = world
        .upgrade(&world.dao.clone(), new_code, ONE_YOCTO)
        .await?;
    assert!(upgraded.is_success(), "{:?}", upgraded.failures());

    let code_hash = hex::encode(Sha256::digest(new_code));
    assert_eq!(
        enzure_events(&upgraded),
        vec![(
            "contract_upgraded".to_string(),
            json!({ "code_hash": code_hash })
        )]
    );
    assert!(world.runs_test_seed_build().await?);

    assert_eq!(
        world.view::<Value>("get_config", json!({})).await?,
        config_before
    );
    assert_eq!(world.assertion(settled).await?, settled_before);
    assert_eq!(world.assertion(pending).await?, pending_before);
    assert_eq!(world.oracle_balance_of(&asserter).await?, balance_before);

    // The new code keeps working on the old state: the pending Assertion settles
    // and the balance can be withdrawn.
    world.wait_for_liveness(pending).await?;
    world.settle(&asserter, pending).await?.assert_success();
    assert_eq!(
        world.oracle_balance_of(&asserter).await?,
        NearToken::from_near(3)
    );
    world
        .call(&asserter, "withdraw", json!({}), ONE_YOCTO)
        .await?
        .assert_success();
    assert_eq!(world.oracle_balance_of(&asserter).await?, NO_DEPOSIT);

    // The upgraded oracle can be upgraded again by the DAO, and by no one else.
    let stranger = world.create_account("stranger").await?;
    let by_stranger = world.upgrade(&stranger, oracle_wasm(), ONE_YOCTO).await?;
    assert!(failure_message(by_stranger).contains("Only the DAO can upgrade the contract"));
    world
        .upgrade(&world.dao.clone(), oracle_wasm(), ONE_YOCTO)
        .await?
        .assert_success();
    assert!(!world.runs_test_seed_build().await?);
    Ok(())
}

#[tokio::test]
async fn code_that_cannot_run_is_not_deployed() -> TestResult {
    let world = World::new().await?;
    let asserter = world.create_account("asserter").await?;
    let id = world
        .post_ok(&asserter, NearToken::from_near(1), None)
        .await?;
    let before = world.assertion(id).await?;

    let broken = world
        .upgrade(&world.dao.clone(), b"\0asm not really wasm", ONE_YOCTO)
        .await?;
    assert!(broken.is_failure());
    assert!(enzure_events(&broken).is_empty());

    // The old code is still there and still has the state.
    assert_eq!(world.assertion(id).await?, before);
    assert!(!world.runs_test_seed_build().await?);
    world
        .upgrade(&world.dao.clone(), oracle_test_seed_wasm(), ONE_YOCTO)
        .await?
        .assert_success();
    assert!(world.runs_test_seed_build().await?);
    Ok(())
}
