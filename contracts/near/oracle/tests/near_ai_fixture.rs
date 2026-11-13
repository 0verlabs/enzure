//! The real signed NEAR AI Cloud response in `fixtures/near-ai-cloud` is
//! accepted, which proves the oracle rebuilds the request bytes exactly.
//!
//! The sandbox's random seed can't be chosen, so this test runs the oracle built
//! with the `test-seed` feature and sets the seed the fixture was signed with.
mod common;

use common::ai::*;
use common::*;
use near_api::NearToken;
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../fixtures/near-ai-cloud/signed-response.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixture is readable"))
        .expect("fixture is JSON")
}

#[tokio::test]
async fn the_real_signed_near_ai_cloud_response_is_accepted_when_its_key_is_registered()
-> TestResult {
    let fixture = fixture();
    let world = World::with_wasm(oracle_test_seed_wasm()).await?;
    let asserter = world.create_account("asserter").await?;
    let disputer = world.create_account("disputer").await?;
    let resolver = world.create_account("resolver").await?;

    let pinned = &fixture["prompt_template"];
    let model = pinned["model_id"].as_str().unwrap();
    world
        .publish_template(json!({
            "model_id": model,
            "system_prompt": pinned["system_prompt"],
            "temperature": pinned["temperature"],
            "max_tokens": pinned["max_tokens"],
            "enable_thinking": pinned["enable_thinking"],
        }))
        .await?;

    let input = &fixture["input"];
    let content = Content::new(
        input["claim"].as_str().unwrap(),
        input["asserter_evidence"].as_str(),
        input["disputer_evidence"].as_str(),
    );
    let bond = NearToken::from_near(1);
    let id = world.post_content(&asserter, &content, bond, 600).await?;
    world
        .call(
            &disputer,
            "set_test_seed",
            json!({ "seed": input["seed"] }),
            NearToken::from_yoctonear(0),
        )
        .await?
        .assert_success();
    world.dispute_ok(&disputer, id, &content, bond).await?;

    let request = world.ai_request(id, &content).await?;
    assert_eq!(request, fixture["request_body"].as_str().unwrap());
    assert_eq!(
        sha256_hex(&request),
        fixture["request_hash"].as_str().unwrap()
    );

    let submission = Submission {
        response_body: fixture["response_body"].as_str().unwrap().to_string(),
        signed_text: fixture["signed_text"].as_str().unwrap().to_string(),
        signature: fixture["signature"].as_str().unwrap().to_string(),
        public_key: fixture["public_key"].as_str().unwrap().to_string(),
    };
    let unregistered = world
        .submit_verdict(&resolver, id, &content, &submission)
        .await?;
    assert!(failure_message(unregistered).contains("not a Registered Key"));

    world
        .call(
            &world.dao,
            "add_registered_key",
            json!({ "public_key": submission.public_key, "model_id": model }),
            ONE_YOCTO,
        )
        .await?
        .assert_success();
    let accepted = world
        .submit_verdict(&resolver, id, &content, &submission)
        .await?;
    let verdict: String = accepted.json()?;
    assert_eq!(verdict, fixture["verdict"].as_str().unwrap());

    let assertion = world.assertion(id).await?;
    assert_eq!(assertion["state"], "ruled");
    assert_eq!(assertion["ai_verdicts"][0]["verdict"], "TRUE");
    assert_eq!(
        assertion["ai_verdicts"][0]["request_hash"],
        fixture["request_hash"]
    );
    assert_eq!(
        assertion["ai_verdicts"][0]["response_hash"],
        fixture["response_hash"]
    );
    Ok(())
}
