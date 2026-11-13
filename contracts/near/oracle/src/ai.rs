//! Building the AI request and reading the AI Verdict from the model's response.
//!
//! The bytes must match `buildAiRequest` in `typescript/packages/core` exactly,
//! because NEAR AI Cloud signs the sha256 of the bytes it received. Keys appear
//! in a fixed order and strings are escaped by serde_json, which escapes the
//! same characters as `JSON.stringify`.
use near_sdk::serde_json::{self, Value};
use near_sdk::{env, near, require};

/// The answer an AI Verdict carries.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    True,
    False,
    Unresolvable,
}

/// A Prompt Template version: the template text, the model and its inference
/// settings. The DAO publishes versions; each Assertion keeps the version that
/// was current when it was posted.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PromptTemplate {
    /// Canonical NEAR AI Cloud model id. It is part of the signed text.
    pub model_id: String,
    /// The system message: instructions telling the model how to judge.
    pub system_prompt: String,
    /// From 0 to 2.
    pub temperature: f64,
    pub max_tokens: u32,
    /// Sent as `chat_template_kwargs.enable_thinking` when set.
    pub enable_thinking: Option<bool>,
}

/// Highest temperature NEAR AI Cloud accepts.
const MAX_TEMPERATURE: f64 = 2.0;

impl PromptTemplate {
    /// Panics if a field could not produce a valid request.
    pub fn validate(&self) {
        require!(!self.model_id.is_empty(), "model_id must not be empty");
        require!(
            !self.model_id.contains(':'),
            "model_id must not contain ':'"
        );
        require!(
            !self.system_prompt.is_empty(),
            "system_prompt must not be empty"
        );
        require!(
            self.temperature.is_finite() && (0.0..=MAX_TEMPERATURE).contains(&self.temperature),
            "temperature must be from 0 to 2"
        );
        require!(self.max_tokens > 0, "max_tokens must be above zero");
    }
}

/// The content an AI Verdict judges. Missing Evidence is sent as an empty string.
pub struct Content<'a> {
    pub claim: &'a str,
    pub asserter_evidence: &'a str,
    pub disputer_evidence: &'a str,
}

/// The exact request body sent to NEAR AI Cloud.
pub fn build_request(template: &PromptTemplate, content: &Content, seed: u32) -> String {
    let data = format!(
        r#"{{"claim":{},"asserter_evidence":{},"disputer_evidence":{}}}"#,
        json_string(content.claim),
        json_string(content.asserter_evidence),
        json_string(content.disputer_evidence),
    );
    let mut body = format!(
        concat!(
            r#"{{"model":{},"messages":[{{"role":"system","content":{}}},{{"role":"user","content":{}}}],"#,
            r#""temperature":{},"seed":{},"max_tokens":{},"stream":false,"#,
            r#""response_format":{{"type":"json_schema","json_schema":{{"name":"verdict","strict":true,"#,
            r#""schema":{{"type":"object","properties":{{"verdict":{{"type":"string","enum":["TRUE","FALSE","UNRESOLVABLE"]}}}},"#,
            r#""required":["verdict"],"additionalProperties":false}}}}}}"#,
        ),
        json_string(&template.model_id),
        json_string(&template.system_prompt),
        json_string(&data),
        json_number(template.temperature),
        seed,
        template.max_tokens,
    );
    if let Some(enable_thinking) = template.enable_thinking {
        body.push_str(&format!(
            r#","chat_template_kwargs":{{"enable_thinking":{enable_thinking}}}"#
        ));
    }
    body.push('}');
    body
}

/// Reads the verdict from a non-streamed chat completion, or returns None.
///
/// The parse is strict and matches `parseVerdict` in core: exactly one choice
/// that finished with `stop`, whose content is a JSON object with only a
/// `verdict` key holding TRUE, FALSE or UNRESOLVABLE.
pub fn parse_verdict(response_body: &str) -> Option<Verdict> {
    let response: Value = serde_json::from_str(response_body).ok()?;
    let [choice] = response.get("choices")?.as_array()?.as_slice() else {
        return None;
    };
    if choice.get("finish_reason")?.as_str()? != "stop" {
        return None;
    }
    let content = choice.get("message")?.get("content")?.as_str()?;
    let answer: Value = serde_json::from_str(content).ok()?;
    let answer = answer.as_object()?;
    if answer.len() != 1 {
        return None;
    }
    match answer.get("verdict")?.as_str()? {
        "TRUE" => Some(Verdict::True),
        "FALSE" => Some(Verdict::False),
        "UNRESOLVABLE" => Some(Verdict::Unresolvable),
        _ => None,
    }
}

fn json_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| env::abort())
}

/// Writes a number the way `JSON.stringify` does for values from 0 to 2:
/// whole numbers without a fraction (`0`, not serde_json's `0.0`), others as
/// the shortest round-tripping decimal.
fn json_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as u64)
    } else {
        serde_json::to_string(&value).unwrap_or_else(|_| env::abort())
    }
}
