//! The real Chain Signatures signing from NEAR testnet in
//! `fixtures/chain-signatures/signed-result.json`: the oracle's result message
//! encoding must give the digest the testnet oracle had signed, and the
//! signature must recover to the oracle's derived EVM address.
mod common;
#[path = "common/evm.rs"]
mod evm;

use common::TestResult;
use evm::{recover, unhex};
use oracle::ResultMessage;
use serde_json::Value;

fn fixture() -> TestResult<Value> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../fixtures/chain-signatures/signed-result.json"
    );
    Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?)
}

fn str_field<'a>(value: &'a Value, name: &str) -> &'a str {
    value[name]
        .as_str()
        .unwrap_or_else(|| panic!("{name} is a string"))
}

#[test]
fn the_contract_encodes_the_testnet_result_message_to_the_signed_digest() -> TestResult {
    let fixture = fixture()?;
    let result = &fixture["signed_result"];
    let message = ResultMessage {
        chain_id: result["chain_id"].as_u64().expect("chain_id"),
        receiver: unhex(str_field(result, "receiver"))
            .try_into()
            .expect("20 bytes"),
        consumer: unhex(str_field(result, "consumer"))
            .try_into()
            .expect("20 bytes"),
        assertion_id: result["assertion_id"].as_u64().expect("assertion_id"),
        outcome: result["outcome"].as_bool().expect("outcome"),
        claim_hash: unhex(str_field(result, "claim_hash"))
            .try_into()
            .expect("32 bytes"),
        asserter: str_field(result, "asserter").parse()?,
        settled_at: str_field(result, "settled_at").parse()?,
    };

    assert_eq!(message.encode(), unhex(str_field(result, "message")));
    assert_eq!(
        message.digest().to_vec(),
        unhex(str_field(result, "digest"))
    );
    Ok(())
}

#[test]
fn the_testnet_signature_recovers_to_the_oracles_derived_address() -> TestResult {
    let fixture = fixture()?;
    let result = &fixture["signed_result"];
    let response = &fixture["signer_response"];

    // r is the x-coordinate of the signer's big_r and v is recovery_id + 27.
    let big_r = str_field(&response["big_r"], "affine_point");
    assert_eq!(str_field(result, "r"), format!("0x{}", &big_r[2..]));
    assert_eq!(
        str_field(result, "s"),
        format!("0x{}", str_field(&response["s"], "scalar"))
    );
    let v = result["v"].as_u64().expect("v") as u8;
    assert_eq!(
        u64::from(v),
        response["recovery_id"].as_u64().expect("id") + 27
    );

    let signer = recover(
        str_field(result, "digest"),
        str_field(result, "r"),
        str_field(result, "s"),
        v,
    );
    assert_eq!(signer, str_field(&fixture, "address"));
    Ok(())
}
