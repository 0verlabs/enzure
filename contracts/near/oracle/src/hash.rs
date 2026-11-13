//! sha256 hashes cross the JSON boundary as 64 hex characters, the form the
//! storage service prints, and are stored as 32 bytes.
use near_sdk::env;

/// Parses a sha256 hash in hex, upper or lower case. Panics with a message
/// naming `field` if it isn't 64 hex characters.
pub fn parse(field: &str, hex: &str) -> [u8; 32] {
    let invalid =
        || -> ! { env::panic_str(&format!("{field} must be a sha256 hash: 64 hex characters")) };
    let bytes = hex.as_bytes();
    if bytes.len() != 64 {
        invalid();
    }
    let mut hash = [0u8; 32];
    for (i, pair) in bytes.chunks_exact(2).enumerate() {
        match (nibble(pair[0]), nibble(pair[1])) {
            (Some(high), Some(low)) => hash[i] = (high << 4) | low,
            _ => invalid(),
        }
    }
    hash
}

/// Formats a hash as lowercase hex.
pub fn to_hex(hash: &[u8; 32]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut hex = String::with_capacity(64);
    for byte in hash {
        hex.push(DIGITS[usize::from(byte >> 4)] as char);
        hex.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    hex
}

fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}
