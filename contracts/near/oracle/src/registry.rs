//! What the DAO approves for AI Verdicts: Prompt Template versions and
//! Registered Keys.
use near_sdk::{env, near, require};

use crate::ai::PromptTemplate;
use crate::events::Event;
use crate::{Oracle, OracleExt, hash};

/// A Registered Key as the views return it.
#[near(serializers = [json])]
pub struct RegisteredKeyView {
    /// The ed25519 public key, in hex.
    pub public_key: String,
    pub model_id: String,
}

/// A Prompt Template version as the views return it.
#[near(serializers = [json])]
pub struct PromptTemplateView {
    pub version: u32,
    #[serde(flatten)]
    pub template: PromptTemplate,
}

#[near]
impl Oracle {
    /// Publishes a new Prompt Template version and returns its number. Versions
    /// start at 1. Assertions posted from now on use it; earlier ones keep
    /// theirs. Only the DAO can call it, attaching one yoctoNEAR.
    #[payable]
    pub fn publish_prompt_template(&mut self, template: PromptTemplate) -> u32 {
        self.require_dao("Only the DAO can publish a Prompt Template");
        template.validate();
        self.prompt_templates.push(template);
        let version = self.prompt_templates.len();
        let template = self
            .prompt_template(version)
            .unwrap_or_else(|| env::abort());
        Event::PromptTemplatePublished {
            version,
            model_id: template.model_id.clone(),
        }
        .emit();
        version
    }

    /// Registers an ed25519 public key (hex) as signing AI Verdicts for
    /// `model_id`, replacing any model it was registered for. Only the DAO can
    /// call it, attaching one yoctoNEAR.
    #[payable]
    pub fn add_registered_key(&mut self, public_key: String, model_id: String) {
        self.require_dao("Only the DAO can manage Registered Keys");
        let key = parse_public_key(&public_key);
        require!(!model_id.is_empty(), "model_id must not be empty");
        self.registered_keys.insert(key, model_id.clone());
        Event::RegisteredKeyAdded {
            public_key: hash::to_hex(&key),
            model_id,
        }
        .emit();
    }

    /// Removes a Registered Key. AI Verdicts it already signed stay accepted.
    /// Only the DAO can call it, attaching one yoctoNEAR.
    #[payable]
    pub fn remove_registered_key(&mut self, public_key: String) {
        self.require_dao("Only the DAO can manage Registered Keys");
        let key = parse_public_key(&public_key);
        let model_id = self
            .registered_keys
            .remove(&key)
            .unwrap_or_else(|| env::panic_str("public_key is not a Registered Key"));
        Event::RegisteredKeyRemoved {
            public_key: hash::to_hex(&key),
            model_id,
        }
        .emit();
    }

    /// Every Registered Key.
    pub fn get_registered_keys(&self) -> Vec<RegisteredKeyView> {
        self.registered_keys
            .iter()
            .map(|(key, model_id)| RegisteredKeyView {
                public_key: hash::to_hex(key),
                model_id: model_id.clone(),
            })
            .collect()
    }

    /// A Prompt Template version, or the current one if `version` is omitted.
    /// Null if there is no such version.
    pub fn get_prompt_template(&self, version: Option<u32>) -> Option<PromptTemplateView> {
        let version = version.or(self.current_prompt_template_version())?;
        self.prompt_template(version)
            .map(|template| PromptTemplateView {
                version,
                template: template.clone(),
            })
    }
}

impl Oracle {
    pub(crate) fn current_prompt_template_version(&self) -> Option<u32> {
        let len = self.prompt_templates.len();
        (len > 0).then_some(len)
    }

    pub(crate) fn prompt_template(&self, version: u32) -> Option<&PromptTemplate> {
        self.prompt_templates.get(version.checked_sub(1)?)
    }

    pub(crate) fn require_dao(&self, message: &str) {
        near_sdk::assert_one_yocto();
        require!(env::predecessor_account_id() == self.dao, message);
    }
}

fn parse_public_key(hex: &str) -> [u8; 32] {
    hash::parse_bytes(hex).unwrap_or_else(|| env::panic_str("public_key must be 64 hex characters"))
}
