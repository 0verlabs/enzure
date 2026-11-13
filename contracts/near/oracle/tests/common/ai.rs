//! Helpers for disputes and AI Verdicts: a test ed25519 key stands in for NEAR
//! AI Cloud, and responses are built the way NEAR AI Cloud returns them.
use ed25519_dalek::{Signer as _, SigningKey};
use near_api::types::transaction::result::ExecutionFinalResult;
use near_api::{AccountId, NearToken};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{ONE_YOCTO, TestResult, World};

/// The model the test Prompt Templates pin.
pub const MODEL: &str = "test/judge-1";

pub fn sha256_hex(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}

/// A Prompt Template for `model`, as `publish_prompt_template` takes it.
pub fn template(model: &str, system_prompt: &str) -> Value {
    json!({
        "model_id": model,
        "system_prompt": system_prompt,
        "temperature": 0,
        "max_tokens": 64,
        "enable_thinking": false,
    })
}

/// An ed25519 key standing in for a NEAR AI Cloud model's signing key.
pub struct TestKey(SigningKey);

impl TestKey {
    pub fn new(seed: u8) -> Self {
        Self(SigningKey::from_bytes(&[seed; 32]))
    }

    pub fn public_hex(&self) -> String {
        hex::encode(self.0.verifying_key().to_bytes())
    }

    pub fn sign(&self, text: &str) -> String {
        hex::encode(self.0.sign(text.as_bytes()).to_bytes())
    }
}

/// A Claim and its Evidence, as the parties uploaded them.
#[derive(Clone)]
pub struct Content {
    pub claim: String,
    pub asserter_evidence: Option<String>,
    pub disputer_evidence: Option<String>,
}

impl Content {
    pub fn new(
        claim: &str,
        asserter_evidence: Option<&str>,
        disputer_evidence: Option<&str>,
    ) -> Self {
        Self {
            claim: claim.to_string(),
            asserter_evidence: asserter_evidence.map(str::to_string),
            disputer_evidence: disputer_evidence.map(str::to_string),
        }
    }

    fn args(&self, id: u64) -> Value {
        json!({
            "assertion_id": id,
            "claim": self.claim,
            "asserter_evidence": self.asserter_evidence,
            "disputer_evidence": self.disputer_evidence,
        })
    }
}

/// What a Resolver submits with the content.
#[derive(Clone)]
pub struct Submission {
    pub response_body: String,
    pub signed_text: String,
    pub signature: String,
    pub public_key: String,
}

impl Submission {
    /// A response signed by `key` the way NEAR AI Cloud signs it.
    pub fn signed(key: &TestKey, model: &str, request: &str, response_body: &str) -> Self {
        let signed_text = format!(
            "{model}:{}:{}",
            sha256_hex(request),
            sha256_hex(response_body)
        );
        Self {
            response_body: response_body.to_string(),
            signature: key.sign(&signed_text),
            signed_text,
            public_key: key.public_hex(),
        }
    }
}

/// A non-streamed chat completion whose message content is `content`.
pub fn completion(chat_id: &str, content: &str) -> String {
    json!({
        "id": chat_id,
        "object": "chat.completion",
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": content },
            "finish_reason": "stop",
        }],
        "model": MODEL,
    })
    .to_string()
}

/// A completion answering `verdict` (TRUE, FALSE or UNRESOLVABLE).
pub fn verdict_response(chat_id: &str, verdict: &str) -> String {
    completion(chat_id, &json!({ "verdict": verdict }).to_string())
}

impl World {
    /// Publishes a Prompt Template as the DAO and returns its version.
    pub async fn publish_template(&self, template: Value) -> TestResult<u32> {
        Ok(self
            .call(
                &self.dao.clone(),
                "publish_prompt_template",
                json!({ "template": template }),
                ONE_YOCTO,
            )
            .await?
            .json()?)
    }

    /// Registers `key` for `model` as the DAO.
    pub async fn register_key(&self, key: &TestKey, model: &str) -> TestResult {
        self.call(
            &self.dao.clone(),
            "add_registered_key",
            json!({ "public_key": key.public_hex(), "model_id": model }),
            ONE_YOCTO,
        )
        .await?
        .assert_success();
        Ok(())
    }

    /// Posts an Assertion committing to `content`'s Claim and Asserter's Evidence.
    pub async fn post_content(
        &self,
        asserter: &AccountId,
        content: &Content,
        bond: NearToken,
        liveness: u64,
    ) -> TestResult<u64> {
        let storage = self.storage_deposit().await?;
        Ok(self
            .call(
                asserter,
                "assert_claim",
                json!({
                    "claim_hash": sha256_hex(&content.claim),
                    "evidence_hash": content.asserter_evidence.as_ref().map(sha256_hex),
                    "bond": bond,
                    "liveness": liveness,
                    "hooks": [],
                }),
                bond.saturating_add(storage),
            )
            .await?
            .json()?)
    }

    pub async fn dispute_storage_deposit(&self) -> TestResult<NearToken> {
        self.view("dispute_storage_deposit", json!({})).await
    }

    /// Calls `dispute` with `deposit` attached.
    pub async fn dispute(
        &self,
        disputer: &AccountId,
        id: u64,
        evidence: Option<&str>,
        deposit: NearToken,
    ) -> TestResult<ExecutionFinalResult> {
        self.call(
            disputer,
            "dispute",
            json!({ "assertion_id": id, "evidence_hash": evidence.map(sha256_hex) }),
            deposit,
        )
        .await
    }

    /// Disputes with `content`'s Disputer Evidence, attaching exactly the bond
    /// plus the storage deposit.
    pub async fn dispute_ok(
        &self,
        disputer: &AccountId,
        id: u64,
        content: &Content,
        bond: NearToken,
    ) -> TestResult {
        let deposit = bond.saturating_add(self.dispute_storage_deposit().await?);
        self.dispute(disputer, id, content.disputer_evidence.as_deref(), deposit)
            .await?
            .assert_success();
        Ok(())
    }

    /// The `ai_request` view.
    pub async fn ai_request(&self, id: u64, content: &Content) -> TestResult<String> {
        self.view("ai_request", content.args(id)).await
    }

    /// Calls `submit_ai_verdict` as `resolver`.
    pub async fn submit_verdict(
        &self,
        resolver: &AccountId,
        id: u64,
        content: &Content,
        submission: &Submission,
    ) -> TestResult<ExecutionFinalResult> {
        let mut args = content.args(id);
        args["response_body"] = json!(submission.response_body);
        args["signed_text"] = json!(submission.signed_text);
        args["signature"] = json!(submission.signature);
        args["public_key"] = json!(submission.public_key);
        self.call(
            resolver,
            "submit_ai_verdict",
            args,
            NearToken::from_yoctonear(0),
        )
        .await
    }

    /// Builds the request with `ai_request`, signs `verdict` with `key` and
    /// submits it.
    pub async fn submit_signed_verdict(
        &self,
        resolver: &AccountId,
        id: u64,
        content: &Content,
        key: &TestKey,
        verdict: &str,
    ) -> TestResult<ExecutionFinalResult> {
        let request = self.ai_request(id, content).await?;
        let response = verdict_response(&format!("chat-{id}-{verdict}"), verdict);
        let submission = Submission::signed(key, MODEL, &request, &response);
        self.submit_verdict(resolver, id, content, &submission)
            .await
    }
}
