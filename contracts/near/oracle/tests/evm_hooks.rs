//! EVM Hooks: posting them, and signing a settled Assertion's result message
//! through Chain Signatures (here, the mock signer).
mod common;
#[path = "common/evm.rs"]
mod evm;

use common::*;
use evm::*;
use near_api::{NearGas, NearToken};
use serde_json::{Value, json};

/// The result message words the spec lays out, built here from the Assertion's
/// public fields: version tag, chain id, Receiver, Consumer, Assertion id,
/// outcome, Claim hash, sha256 of the Asserter's account id, settlement time.
fn expected_message(id: u64, asserter: &str, settled_at: u64) -> String {
    let uint = |n: u64| format!("{n:064x}");
    let address = |a: &str| format!("{:0>64}", &a[2..]);
    let sha256 = |bytes: &[u8]| {
        use k256::sha2::{Digest, Sha256};
        hex(&Sha256::digest(bytes))
    };
    format!(
        "0x{}{}{}{}{}{}{}{}{}",
        hex(&keccak256(b"enzure.hook.v1")),
        uint(CHAIN_ID),
        address(RECEIVER),
        address(CONSUMER),
        uint(id),
        uint(1),
        CLAIM_HASH,
        sha256(asserter.as_bytes()),
        uint(settled_at),
    )
}

fn event<'a>(events: &'a [(String, Value)], name: &str) -> &'a Value {
    &events
        .iter()
        .find(|(event, _)| event == name)
        .unwrap_or_else(|| panic!("no {name} event in {events:?}"))
        .1
}

#[tokio::test]
async fn an_evm_hook_is_posted_with_its_destinations_and_waits_for_settlement() -> TestResult {
    let evm = EvmWorld::new().await?;
    let asserter = evm.world.create_account("asserter").await?;

    let mixed_case = json!({ "evm": {
        "chain_id": CHAIN_ID,
        "receiver": RECEIVER,
        "consumer": "0xABCDEF0000000000000000000000000000000002",
    } });
    let id: u64 = evm
        .world
        .post_with_hooks(&asserter, BOND, json!([mixed_case]))
        .await?
        .json()?;

    assert_eq!(
        evm.evm_hook(id, 0).await?,
        json!({
            "chain_id": CHAIN_ID,
            "receiver": RECEIVER,
            "consumer": "0xabcdef0000000000000000000000000000000002",
            "status": "unsigned",
        })
    );
    assert_eq!(evm.signed_result(id, 0).await?, Value::Null);
    assert_eq!(
        evm.world.view::<Value>("get_evm_signer", json!({})).await?,
        json!({ "signer": evm.signer, "path": "enzure-hooks-evm", "domain_id": 0 })
    );

    // Signing waits for settlement.
    let early = evm.sign_hook(&asserter, id, 0, ONE_YOCTO).await?;
    assert!(failure_message(early).contains("is not settled"));
    assert!(evm.signer_requests().await?.is_empty());
    Ok(())
}

#[tokio::test]
async fn the_oracle_signs_the_result_message_it_builds_from_settled_state() -> TestResult {
    let evm = EvmWorld::new().await?;
    let asserter = evm.world.create_account("asserter").await?;
    let relayer = evm.world.create_account("relayer").await?;
    let id = evm.settled_with(&asserter, json!([evm_hook()])).await?;
    let settled_at_ns: u64 = evm.world.assertion(id).await?["settled_at_ns"]
        .as_str()
        .expect("settled")
        .parse()?;

    let signed = evm.sign_hook(&relayer, id, 0, ONE_YOCTO).await?;
    assert!(signed.clone().json::<bool>()?);

    let result = evm.signed_result(id, 0).await?;
    let message = expected_message(id, asserter.as_str(), settled_at_ns / 1_000_000_000);
    assert_eq!(result["message"], message);
    let digest = format!("0x{}", hex(&keccak256(&unhex(&message))));
    assert_eq!(result["digest"], digest);
    assert_eq!(result["chain_id"], CHAIN_ID);
    assert_eq!(result["receiver"], RECEIVER);
    assert_eq!(result["consumer"], CONSUMER);
    assert_eq!(result["assertion_id"], id);
    assert_eq!(result["outcome"], true);
    assert_eq!(result["claim_hash"], format!("0x{CLAIM_HASH}"));
    assert_eq!(result["asserter"], asserter.as_str());
    assert_eq!(
        result["settled_at"],
        (settled_at_ns / 1_000_000_000).to_string()
    );
    let v = result["v"].as_u64().expect("v") as u8;
    assert!(v == 27 || v == 28);
    let recovered = recover(
        &digest,
        result["r"].as_str().expect("r"),
        result["s"].as_str().expect("s"),
        v,
    );
    assert_eq!(recovered, mock_signer_address());

    // The same signed result is published for Relayers.
    let events = enzure_events(&signed);
    assert_eq!(
        event(&events, "evm_hook_signed"),
        &json!({ "assertion_id": id, "hook_index": 0, "signed_result": result })
    );
    assert_eq!(evm.evm_hook(id, 0).await?["status"], "signed");

    // The signer got the digest, the fixed path, domain 0 and the deposit.
    let requests = evm.signer_requests().await?;
    assert_eq!(
        requests,
        [json!({
            "predecessor": evm.world.oracle,
            "deposit": ONE_YOCTO,
            "request": {
                "path": "enzure-hooks-evm",
                "payload_v2": { "Ecdsa": &digest[2..] },
                "domain_id": 0,
            },
        })]
    );

    let again = evm.sign_hook(&relayer, id, 0, ONE_YOCTO).await?;
    assert!(failure_message(again).contains("already signed"));
    Ok(())
}

#[tokio::test]
async fn sign_hook_needs_a_deposit_gas_and_an_evm_hook() -> TestResult {
    let evm = EvmWorld::new().await?;
    let asserter = evm.world.create_account("asserter").await?;
    let near_hook =
        json!({ "near": { "consumer": "nobody.sandbox", "gas": NearGas::from_tgas(5) } });
    let id = evm
        .settled_with(&asserter, json!([near_hook, evm_hook()]))
        .await?;

    let unpaid = evm
        .sign_hook(&asserter, id, 1, NearToken::from_yoctonear(0))
        .await?;
    assert!(failure_message(unpaid).contains("Attach the Chain Signatures deposit"));

    let low_gas = evm
        .world
        .call_contract_with_gas(
            &asserter,
            &evm.world.oracle,
            "sign_hook",
            json!({ "assertion_id": id, "hook_index": 1 }),
            ONE_YOCTO,
            NearGas::from_tgas(40),
        )
        .await?;
    assert!(failure_message(low_gas).contains("gas to sign a Hook"));

    for index in [0, 2] {
        let wrong = evm.sign_hook(&asserter, id, index, ONE_YOCTO).await?;
        assert!(failure_message(wrong).contains(&format!("has no EVM Hook at index {index}")));
    }

    // `hook_index` counts NEAR and EVM Hooks together.
    let signed = evm.sign_hook(&asserter, id, 1, ONE_YOCTO).await?;
    assert!(signed.json::<bool>()?);
    assert_eq!(evm.evm_hook(id, 1).await?["status"], "signed");
    Ok(())
}

#[tokio::test]
async fn a_failed_signing_leaves_the_hook_ready_to_sign_again() -> TestResult {
    let evm = EvmWorld::new().await?;
    let asserter = evm.world.create_account("asserter").await?;
    let id = evm.settled_with(&asserter, json!([evm_hook()])).await?;

    evm.set_mode("fail").await?;
    // A failed signing hands the deposit back to the caller, not the oracle.
    let deposit = NearToken::from_near(1);
    let before = evm.world.near_balance(&asserter).await?;
    let failed = evm.sign_hook(&asserter, id, 0, deposit).await?;
    let spent = before.saturating_sub(evm.world.near_balance(&asserter).await?);
    assert!(
        spent < NearToken::from_millinear(20),
        "a failed signing kept {spent}"
    );
    // The callback doesn't panic: the transaction succeeds and returns false.
    assert!(!failed.clone().json::<bool>()?);
    assert_eq!(
        event(&enzure_events(&failed), "evm_hook_signing_failed"),
        &json!({ "assertion_id": id, "hook_index": 0, "reason": "signer_failed" })
    );
    assert_eq!(evm.evm_hook(id, 0).await?["status"], "unsigned");
    assert_eq!(evm.signed_result(id, 0).await?, Value::Null);

    evm.set_mode("sign").await?;
    let retried = evm.sign_hook(&asserter, id, 0, ONE_YOCTO).await?;
    assert!(retried.json::<bool>()?);
    assert_eq!(evm.evm_hook(id, 0).await?["status"], "signed");
    // The failed request was rolled back with the signer's panic; only the
    // retry reached it.
    assert_eq!(evm.signer_requests().await?.len(), 1);
    Ok(())
}

#[tokio::test]
async fn a_hook_being_signed_cant_be_signed_twice_and_a_timeout_frees_it() -> TestResult {
    let evm = EvmWorld::new().await?;
    let asserter = evm.world.create_account("asserter").await?;
    let other = evm.world.create_account("other").await?;
    let id = evm.settled_with(&asserter, json!([evm_hook()])).await?;

    evm.set_mode("hang").await?;
    let pending = evm.sign_hook(&asserter, id, 0, ONE_YOCTO);
    let meanwhile = async {
        // Wait until the request reaches the signer.
        while evm.signer_requests().await?.is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        assert_eq!(evm.evm_hook(id, 0).await?["status"], "signing");
        let second = evm.sign_hook(&other, id, 0, ONE_YOCTO).await?;
        assert!(failure_message(second).contains("already being signed"));
        // The signer's request times out after 200 blocks.
        evm.world.sandbox.fast_forward(250).await?;
        TestResult::Ok(())
    };
    let (timed_out, checks) = tokio::join!(pending, meanwhile);
    checks?;
    let timed_out = timed_out?;
    assert!(!timed_out.clone().json::<bool>()?);
    assert_eq!(
        event(&enzure_events(&timed_out), "evm_hook_signing_failed"),
        &json!({ "assertion_id": id, "hook_index": 0, "reason": "signer_failed" })
    );
    assert_eq!(evm.evm_hook(id, 0).await?["status"], "unsigned");

    evm.set_mode("sign").await?;
    let retried = evm.sign_hook(&other, id, 0, ONE_YOCTO).await?;
    assert!(retried.json::<bool>()?);
    Ok(())
}

#[tokio::test]
async fn malformed_evm_hooks_are_rejected() -> TestResult {
    let evm = EvmWorld::new().await?;
    let asserter = evm.world.create_account("asserter").await?;
    let cases = [
        (
            json!({ "evm": { "chain_id": CHAIN_ID, "receiver": "0x1234", "consumer": CONSUMER } }),
            "hooks[0].evm.receiver must be an EVM address",
        ),
        (
            json!({ "evm": { "chain_id": CHAIN_ID, "receiver": RECEIVER, "consumer": "2000000000000000000000000000000000000002" } }),
            "hooks[0].evm.consumer must be an EVM address",
        ),
        (
            json!({ "evm": { "chain_id": CHAIN_ID, "receiver": RECEIVER, "consumer": "0x0000000000000000000000000000000000000000" } }),
            "hooks[0].evm.consumer must not be the zero address",
        ),
        (
            json!({ "evm": { "chain_id": 0, "receiver": RECEIVER, "consumer": CONSUMER } }),
            "hooks[0].evm.chain_id must be above zero",
        ),
    ];
    for (hook, expected) in cases {
        let result = evm
            .world
            .post_with_hooks(&asserter, BOND, json!([hook]))
            .await?;
        let message = failure_message(result);
        assert!(
            message.contains(expected),
            "{message} should mention {expected:?}"
        );
    }

    let too_many = json!(vec![evm_hook(); 5]);
    let result = evm.world.post_with_hooks(&asserter, BOND, too_many).await?;
    assert!(failure_message(result).contains("At most 4 Hooks"));
    Ok(())
}

#[tokio::test]
async fn four_signed_evm_hooks_fit_the_storage_deposit() -> TestResult {
    let evm = EvmWorld::new().await?;
    let asserter = evm.world.create_account("asserter").await?;
    let used_before = evm.world.storage_usage(&evm.world.oracle).await?;
    let id = evm
        .settled_with(&asserter, json!(vec![evm_hook(); 4]))
        .await?;
    for index in 0..4 {
        let signed = evm.sign_hook(&asserter, id, index, ONE_YOCTO).await?;
        assert!(signed.json::<bool>()?);
    }
    let used = evm.world.storage_usage(&evm.world.oracle).await? - used_before;
    let storage = evm.world.storage_deposit_for(4).await?;
    let byte_cost = NearToken::from_yoctonear(10u128.pow(19));
    assert!(
        byte_cost.saturating_mul(used.into()) <= storage,
        "an Assertion with 4 signed EVM Hooks used {used} bytes, more than the deposit pays for"
    );
    Ok(())
}
