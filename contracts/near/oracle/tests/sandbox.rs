use near_api::{AccountId, NearToken};

/// Deploys the placeholder oracle to a local sandbox and calls its `version` view.
#[tokio::test]
async fn deployed_oracle_answers_version_view() -> testresult::TestResult<()> {
    let wasm_path = cargo_near_build::build_with_cli(Default::default())?;
    let wasm = std::fs::read(wasm_path)?;

    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = near_api::Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
    )?;

    let oracle_id: AccountId = "oracle.sandbox".parse()?;
    sandbox
        .create_account(oracle_id.as_str().parse()?)
        .initial_balance(NearToken::from_near(10))
        .send()
        .await?;

    near_api::Contract::deploy(oracle_id.clone())
        .use_code(wasm)
        .without_init_call()
        .with_signer(signer)
        .send_to(&network)
        .await?
        .assert_success();

    let version: String = near_api::Contract(oracle_id)
        .call_function("version", ())
        .read_only()
        .fetch_from(&network)
        .await?
        .data;

    assert_eq!(version, env!("CARGO_PKG_VERSION"));
    Ok(())
}
