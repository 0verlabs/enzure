//! Sandbox harness shared by the oracle's integration tests. Tests reach the
//! oracle only through its public methods, views, events and account balances.
#![allow(dead_code)]

use std::sync::{Arc, OnceLock};

use near_api::types::transaction::result::{ExecutionFinalResult, TransactionResult};
use near_api::{AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

pub use testresult::TestResult;

pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// A claim hash as the storage service would print it (sha256, lowercase hex).
pub const CLAIM_HASH: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
pub const EVIDENCE_HASH: &str = "60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752";

static ORACLE_WASM: OnceLock<Vec<u8>> = OnceLock::new();
static SELF_DELETING_ACCOUNT_WASM: OnceLock<Vec<u8>> = OnceLock::new();

/// Builds the oracle once per test binary.
pub fn oracle_wasm() -> &'static [u8] {
    ORACLE_WASM.get_or_init(|| {
        let path = cargo_near_build::build_with_cli(Default::default()).expect("oracle builds");
        std::fs::read(path).expect("oracle wasm is readable")
    })
}

/// Builds the test-only contract in `tests/contracts/self_deleting_account`.
pub fn self_deleting_account_wasm() -> &'static [u8] {
    SELF_DELETING_ACCOUNT_WASM.get_or_init(|| {
        let manifest = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/contracts/self_deleting_account/Cargo.toml"
        );
        let opts = cargo_near_build::BuildOpts::builder()
            .manifest_path(manifest)
            .no_abi(true)
            .build();
        let path = cargo_near_build::build_with_cli(opts).expect("test contract builds");
        std::fs::read(path).expect("test contract wasm is readable")
    })
}

static SWITCHABLE_CONSUMER_WASM: OnceLock<Vec<u8>> = OnceLock::new();
static EXAMPLE_NEAR_CONSUMER_WASM: OnceLock<Vec<u8>> = OnceLock::new();

/// Builds a contract outside the oracle crate, sharing the workspace's target folder.
pub fn build_contract(manifest: &str) -> Vec<u8> {
    let target = concat!(env!("CARGO_MANIFEST_DIR"), "/../target");
    let opts = cargo_near_build::BuildOpts::builder()
        .manifest_path(manifest)
        .no_abi(true)
        .override_cargo_target_dir(target.to_string())
        .build();
    let path = cargo_near_build::build_with_cli(opts).expect("contract builds");
    std::fs::read(path).expect("contract wasm is readable")
}

/// Builds the test-only Consumer in `tests/contracts/switchable_consumer`.
pub fn switchable_consumer_wasm() -> &'static [u8] {
    SWITCHABLE_CONSUMER_WASM.get_or_init(|| {
        build_contract(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/contracts/switchable_consumer/Cargo.toml"
        ))
    })
}

/// Builds the example NEAR Consumer in the root `examples/near-consumer` folder.
pub fn example_near_consumer_wasm() -> &'static [u8] {
    EXAMPLE_NEAR_CONSUMER_WASM.get_or_init(|| {
        build_contract(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../examples/near-consumer/Cargo.toml"
        ))
    })
}

/// A sandbox with the oracle deployed and initialised with `dao.sandbox` as its DAO.
pub struct World {
    pub sandbox: near_sandbox::Sandbox,
    pub network: NetworkConfig,
    pub signer: Arc<Signer>,
    pub oracle: AccountId,
    pub dao: AccountId,
}

impl World {
    pub async fn new() -> TestResult<Self> {
        Self::with_init_args(json!({})).await
    }

    /// Like `new`, with `extra` merged into the oracle's `new` arguments.
    pub async fn with_init_args(extra: Value) -> TestResult<Self> {
        let wasm = oracle_wasm().to_vec();
        let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
        let network = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(
            near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
        )?;

        let mut world = Self {
            sandbox,
            network,
            signer,
            oracle: "oracle.sandbox".parse()?,
            dao: "dao.sandbox".parse()?,
        };
        world.dao = world.create_account("dao").await?;
        world.oracle = world.create_account("oracle").await?;

        let mut init_args = json!({ "dao": world.dao });
        if let (Some(args), Value::Object(extra)) = (init_args.as_object_mut(), extra) {
            args.extend(extra);
        }
        Contract::deploy(world.oracle.clone())
            .use_code(wasm)
            .with_init_call("new", init_args)?
            .with_signer(world.signer.clone())
            .send_to(&world.network)
            .await?
            .assert_success();
        Ok(world)
    }

    /// Creates `<name>.sandbox` with 100 NEAR, signed by the shared sandbox key.
    pub async fn create_account(&self, name: &str) -> TestResult<AccountId> {
        let id: AccountId = format!("{name}.sandbox").parse()?;
        self.sandbox
            .create_account(id.as_str().parse()?)
            .initial_balance(NearToken::from_near(100))
            .send()
            .await?;
        Ok(id)
    }

    /// Calls an oracle method as `signer_id`.
    pub async fn call(
        &self,
        signer_id: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> TestResult<ExecutionFinalResult> {
        self.call_contract(signer_id, &self.oracle, method, args, deposit)
            .await
    }

    /// Calls any contract method as `signer_id`, with 300 TGas.
    pub async fn call_contract(
        &self,
        signer_id: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> TestResult<ExecutionFinalResult> {
        self.call_contract_with_gas(
            signer_id,
            contract,
            method,
            args,
            deposit,
            NearGas::from_tgas(300),
        )
        .await
    }

    /// Calls any contract method as `signer_id`, attaching `gas`.
    pub async fn call_contract_with_gas(
        &self,
        signer_id: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
        gas: NearGas,
    ) -> TestResult<ExecutionFinalResult> {
        let result = Contract(contract.clone())
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .gas(gas)
            .with_signer(signer_id.clone(), self.signer.clone())
            .send_to(&self.network)
            .await?;
        match result {
            TransactionResult::Full(result) => Ok(*result),
            TransactionResult::Pending { status } => {
                Err(format!("transaction still pending: {status:?}").into())
            }
        }
    }

    /// Creates `<name>.sandbox` and deploys `wasm` to it, calling `init` with
    /// `init_args` if given.
    pub async fn deploy(
        &self,
        name: &str,
        wasm: &[u8],
        init: Option<(&str, Value)>,
    ) -> TestResult<AccountId> {
        let id = self.create_account(name).await?;
        let deploy = Contract::deploy(id.clone()).use_code(wasm.to_vec());
        let result = match init {
            Some((method, args)) => {
                deploy
                    .with_init_call(method, args)?
                    .with_signer(self.signer.clone())
                    .send_to(&self.network)
                    .await?
            }
            None => {
                deploy
                    .without_init_call()
                    .with_signer(self.signer.clone())
                    .send_to(&self.network)
                    .await?
            }
        };
        result.assert_success();
        Ok(id)
    }

    /// Calls a view method on any contract.
    pub async fn view_contract<T: DeserializeOwned + Send + Sync>(
        &self,
        contract: &AccountId,
        method: &str,
        args: Value,
    ) -> TestResult<T> {
        Ok(Contract(contract.clone())
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.network)
            .await?
            .data)
    }

    /// Posts an Assertion with Hooks and a one-minute Liveness, attaching the bond
    /// plus the storage deposit the oracle asks for that many Hooks.
    pub async fn post_with_hooks(
        &self,
        asserter: &AccountId,
        bond: NearToken,
        hooks: Value,
    ) -> TestResult<ExecutionFinalResult> {
        let count = hooks.as_array().map_or(0, Vec::len);
        let storage = self.storage_deposit_for(count as u32).await?;
        self.call(
            asserter,
            "assert_claim",
            json!({
                "claim_hash": CLAIM_HASH,
                "evidence_hash": EVIDENCE_HASH,
                "bond": bond,
                "liveness": 60,
                "hooks": hooks,
            }),
            bond.saturating_add(storage),
        )
        .await
    }

    /// The storage deposit for an Assertion with `hooks` Hooks.
    pub async fn storage_deposit_for(&self, hooks: u32) -> TestResult<NearToken> {
        self.view("assertion_storage_deposit", json!({ "hooks": hooks }))
            .await
    }

    /// Calls `settle` as `caller`, attaching `gas`.
    pub async fn settle_with_gas(
        &self,
        caller: &AccountId,
        id: u64,
        gas: NearGas,
    ) -> TestResult<ExecutionFinalResult> {
        self.call_contract_with_gas(
            caller,
            &self.oracle,
            "settle",
            json!({ "assertion_id": id }),
            NearToken::from_yoctonear(0),
            gas,
        )
        .await
    }

    /// Waits for Liveness to end on the Assertion.
    pub async fn wait_for_liveness(&self, id: u64) -> TestResult<()> {
        let ends = self.assertion(id).await?["liveness_ends_at_ns"]
            .as_str()
            .expect("timestamp string")
            .parse()?;
        self.advance_clock_to(ends).await
    }

    /// Calls an oracle view method.
    pub async fn view<T: DeserializeOwned + Send + Sync>(
        &self,
        method: &str,
        args: Value,
    ) -> TestResult<T> {
        Ok(Contract(self.oracle.clone())
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.network)
            .await?
            .data)
    }

    /// Posts an Assertion with the given bond and Liveness, attaching the bond plus
    /// the storage deposit the oracle asks for.
    pub async fn post(
        &self,
        asserter: &AccountId,
        bond: NearToken,
        liveness: Option<u64>,
    ) -> TestResult<ExecutionFinalResult> {
        let storage = self.storage_deposit().await?;
        self.call(
            asserter,
            "assert_claim",
            json!({
                "claim_hash": CLAIM_HASH,
                "evidence_hash": EVIDENCE_HASH,
                "bond": bond,
                "liveness": liveness,
                "hooks": [],
            }),
            bond.saturating_add(storage),
        )
        .await
    }

    /// Posts an Assertion and returns its id, failing the test if posting fails.
    pub async fn post_ok(
        &self,
        asserter: &AccountId,
        bond: NearToken,
        liveness: Option<u64>,
    ) -> TestResult<u64> {
        Ok(self.post(asserter, bond, liveness).await?.json()?)
    }

    /// Calls `settle` as `caller`.
    pub async fn settle(&self, caller: &AccountId, id: u64) -> TestResult<ExecutionFinalResult> {
        self.call(
            caller,
            "settle",
            json!({ "assertion_id": id }),
            NearToken::from_yoctonear(0),
        )
        .await
    }

    pub async fn storage_deposit(&self) -> TestResult<NearToken> {
        self.view("assertion_storage_deposit", json!({})).await
    }

    pub async fn assertion(&self, id: u64) -> TestResult<Value> {
        self.view("get_assertion", json!({ "assertion_id": id }))
            .await
    }

    pub async fn oracle_balance_of(&self, account: &AccountId) -> TestResult<NearToken> {
        self.view("get_balance", json!({ "account_id": account }))
            .await
    }

    /// The account's NEAR balance on chain, not counting storage-locked funds.
    pub async fn near_balance(&self, account: &AccountId) -> TestResult<NearToken> {
        Ok(near_api::Tokens::account(account.clone())
            .near_balance()
            .fetch_from(&self.network)
            .await?
            .total)
    }

    /// Bytes of state the account holds.
    pub async fn storage_usage(&self, account: &AccountId) -> TestResult<u64> {
        Ok(near_api::Account(account.clone())
            .view()
            .fetch_from(&self.network)
            .await?
            .data
            .storage_usage)
    }

    /// The latest block's timestamp in nanoseconds.
    pub async fn now_ns(&self) -> TestResult<u64> {
        Ok(near_api::Chain::block()
            .fetch_from(&self.network)
            .await?
            .header
            .timestamp)
    }

    /// Produces blocks until the chain's clock is at least `ns`.
    pub async fn advance_clock_to(&self, ns: u64) -> TestResult<()> {
        while self.now_ns().await? < ns {
            self.sandbox.fast_forward(100).await?;
        }
        Ok(())
    }
}

/// The panic message of a failed transaction, for asserting on rejections.
pub fn failure_message(result: ExecutionFinalResult) -> String {
    match result.into_result() {
        Ok(_) => panic!("expected the transaction to fail"),
        Err(failure) => failure.to_string(),
    }
}

/// Every NEP-297 event a transaction logged, as `(event, data)` pairs, checking
/// each one is under the `enzure` standard at version 1.0.0.
pub fn enzure_events(result: &ExecutionFinalResult) -> Vec<(String, Value)> {
    result
        .logs()
        .into_iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|json| {
            let event: Value = serde_json::from_str(json).expect("event is JSON");
            assert_eq!(event["standard"], "enzure");
            assert_eq!(event["version"], "1.0.0");
            (
                event["event"].as_str().expect("event name").to_string(),
                event["data"].clone(),
            )
        })
        .collect()
}
