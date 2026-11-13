import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "./signature.ts";

/** Hashed with keccak256 to make the result message's first word. */
export const RESULT_MESSAGE_VERSION = "enzure.hook.v1";

/** What the oracle signs for one EVM Hook of a settled Assertion. */
export interface ResultMessage {
  chainId: bigint;
  /** The Receiver's EVM address, `0x` and 40 hex characters. */
  receiver: string;
  /** The Consumer's EVM address. */
  consumer: string;
  assertionId: bigint;
  outcome: boolean;
  /** sha256 of the Claim, 32 bytes of hex with or without `0x`. */
  claimHash: string;
  /** The Asserter's NEAR account id; the message holds its sha256. */
  asserter: string;
  /** Settlement time in Unix seconds. */
  settledAt: bigint;
}

/** An EVM signature as the oracle stores it: `v` is 27 or 28. */
export interface EvmSignature {
  r: string;
  s: string;
  v: number;
}

/**
 * The nine 32-byte words of the result message, exactly Solidity's
 * `abi.encode(bytes32 version, uint256 chainId, address receiver, address
 * consumer, uint256 assertionId, bool outcome, bytes32 claimHash, bytes32
 * asserterHash, uint256 settledAt)`, as the oracle contract encodes them.
 * Throws on a malformed address or hash.
 */
export function encodeResultMessage(message: ResultMessage): Uint8Array {
  const words = [
    keccak_256(new TextEncoder().encode(RESULT_MESSAGE_VERSION)),
    uintWord(message.chainId),
    addressWord(message.receiver),
    addressWord(message.consumer),
    uintWord(message.assertionId),
    uintWord(message.outcome ? 1n : 0n),
    requireBytes(message.claimHash, 32, "claimHash"),
    sha256(new TextEncoder().encode(message.asserter)),
    uintWord(message.settledAt),
  ];
  const encoded = new Uint8Array(words.length * 32);
  words.forEach((word, i) => encoded.set(word, i * 32));
  return encoded;
}

/** keccak256 of the encoded result message: the 32 bytes the oracle signs, with no EIP-191 prefix. */
export function resultMessageDigest(message: ResultMessage): Uint8Array {
  return keccak_256(encodeResultMessage(message));
}

/**
 * The EVM address of a secp256k1 public key, as `0x` lowercase hex. Takes the
 * signer's `derived_public_key` answer (`secp256k1:<base58 of 64 bytes>`) or
 * the key as hex, 64 bytes uncompressed without the `04` prefix, 65 with it,
 * or 33 compressed.
 */
export function evmAddressFromPublicKey(publicKey: string): string {
  let key = publicKey.startsWith("secp256k1:")
    ? base58Decode(publicKey.slice("secp256k1:".length))
    : hexToAnyBytes(publicKey);
  if (key.length === 64) key = Uint8Array.of(4, ...key);
  const point = secp256k1.Point.fromBytes(key).toBytes(false);
  return `0x${bytesToHex(keccak_256(point.slice(1)).slice(12))}`;
}

/** The address that signed `digest`, recovered as EVM `ecrecover` does. Throws on an invalid signature. */
export function recoverEvmSigner(digest: Uint8Array, signature: EvmSignature): string {
  if (signature.v !== 27 && signature.v !== 28) throw new Error("v must be 27 or 28");
  const compact = new Uint8Array(65);
  compact[0] = signature.v - 27;
  compact.set(requireBytes(signature.r, 32, "r"), 1);
  compact.set(requireBytes(signature.s, 32, "s"), 33);
  const key = secp256k1.recoverPublicKey(compact, digest, { prehash: false });
  return evmAddressFromPublicKey(bytesToHex(key));
}

function uintWord(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) throw new Error("value must fit in uint256");
  return requireBytes(value.toString(16).padStart(64, "0"), 32, "uint");
}

function addressWord(address: string): Uint8Array {
  if (!address.startsWith("0x")) throw new Error(`${address} must start with 0x`);
  const word = new Uint8Array(32);
  word.set(requireBytes(address, 20, "address"), 12);
  return word;
}

function requireBytes(hex: string, length: number, name: string): Uint8Array {
  const bytes = hexToBytes(hex, length);
  if (bytes === undefined) throw new Error(`${name} must be ${length} bytes of hex`);
  return bytes;
}

function hexToAnyBytes(hex: string): Uint8Array {
  const digits = hex.startsWith("0x") ? hex.slice(2) : hex;
  return requireBytes(digits, digits.length / 2, "publicKey");
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const digit = BASE58.indexOf(c);
    if (digit < 0) throw new Error("public key is not base58");
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 255n));
  for (const c of text) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}
