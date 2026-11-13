# Shared by the NEAR scripts. Source it; don't run it.
#
# Signing uses access-key files written to a private temporary folder, so private
# keys never appear in command lines. Call near_keys_init first.

NEAR_NETWORK="testnet"
NEAR_EXPLORER="https://testnet.nearblocks.io/txns"

# Loads NAME from the repository's .env unless it is already set.
load_env() {
  local root="$1" name value
  shift
  [ -f "$root/.env" ] || return 0
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then
      value="$(sed -n "s/^${name}=//p" "$root/.env" | tail -n 1)"
      if [ -n "$value" ]; then
        export "$name=$value"
      fi
    fi
  done
}

# Prints the ed25519 public key for the private key in NEAR_PRIVATE_KEY. A NEAR
# private key is the base58 of the 32-byte seed followed by the 32-byte public key.
near_public_key() {
  node --input-type=module -e '
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const decode = (text) => {
      let n = 0n;
      for (const c of text) {
        const digit = alphabet.indexOf(c);
        if (digit < 0) throw new Error("NEAR_PRIVATE_KEY is not base58");
        n = n * 58n + BigInt(digit);
      }
      const bytes = [];
      for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 255n));
      for (const c of text) { if (c !== "1") break; bytes.unshift(0); }
      return bytes;
    };
    const encode = (bytes) => {
      let n = bytes.reduce((acc, b) => acc * 256n + BigInt(b), 0n);
      let text = "";
      for (; n > 0n; n /= 58n) text = alphabet[Number(n % 58n)] + text;
      for (const b of bytes) { if (b !== 0) break; text = "1" + text; }
      return text;
    };
    const key = process.env.NEAR_PRIVATE_KEY ?? "";
    if (!key.startsWith("ed25519:")) throw new Error("NEAR_PRIVATE_KEY must start with ed25519:");
    const bytes = decode(key.slice("ed25519:".length));
    if (bytes.length !== 64) throw new Error("NEAR_PRIVATE_KEY must decode to 64 bytes");
    console.log("ed25519:" + encode(bytes.slice(32)));
  '
}

# Creates the private folder for key files and removes it when the script exits.
near_keys_init() {
  NEAR_KEYS_DIR="$(mktemp -d)"
  chmod 700 "$NEAR_KEYS_DIR"
  trap 'rm -rf "$NEAR_KEYS_DIR"' EXIT
  NEAR_PUBLIC_KEY="$(near_public_key)"
}

# Prints the path of an access-key file that signs as ACCOUNT_ID with NEAR_PRIVATE_KEY.
near_key_file() {
  local account_id="$1" file="$NEAR_KEYS_DIR/$1.json"
  if [ ! -f "$file" ]; then
    (
      umask 077
      printf '{"account_id":"%s","public_key":"%s","private_key":"%s"}\n' \
        "$account_id" "$NEAR_PUBLIC_KEY" "$NEAR_PRIVATE_KEY" >"$file"
    )
  fi
  printf '%s\n' "$file"
}

# Prints the sum of two yoctoNEAR amounts.
yocto_add() {
  node -e 'console.log((BigInt(process.argv[1]) + BigInt(process.argv[2])).toString())' "$1" "$2"
}

# Prints the transaction hash from near CLI output.
tx_hash_of() {
  sed -n 's/.*Transaction ID: \([1-9A-HJ-NP-Za-km-z]\{43,44\}\).*/\1/p' <<<"$1" | head -n 1
}
