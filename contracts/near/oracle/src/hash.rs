//! sha256 hashes cross the JSON boundary as 64 hex characters, the form the
//! storage service prints, and are stored as 32 bytes.
use near_sdk::env;

/// Parses a sha256 hash in hex, upper or lower case. Panics with a message
/// naming `field` if it isn't 64 hex characters.
pub fn parse(field: &str, hex: &str) -> [u8; 32] {
    parse_bytes(hex).unwrap_or_else(|| {
        env::panic_str(&format!("{field} must be a sha256 hash: 64 hex characters"))
    })
}

/// Decodes exactly `N` bytes of hex, upper or lower case, or returns None.
pub fn parse_bytes<const N: usize>(hex: &str) -> Option<[u8; N]> {
    let bytes = hex.as_bytes();
    if bytes.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (i, pair) in bytes.chunks_exact(2).enumerate() {
        out[i] = (nibble(pair[0])? << 4) | nibble(pair[1])?;
    }
    Some(out)
}

/// The sha256 of `bytes`.
pub fn sha256(bytes: impl AsRef<[u8]>) -> [u8; 32] {
    env::sha256_array(bytes)
}

/// Formats bytes as lowercase hex.
pub fn to_hex<const N: usize>(hash: &[u8; N]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut hex = String::with_capacity(N * 2);
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
