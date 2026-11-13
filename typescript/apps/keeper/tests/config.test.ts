import { expect, test } from "vite-plus/test";
import { loadConfig } from "../src/config.ts";

const required = {
  ORACLE_ACCOUNT_ID: "oracle.enzure.testnet",
  NEAR_ACCOUNT_ID: "keeper.enzure.testnet",
  // Not a key: base58 characters in the shape loadConfig checks, nothing more.
  NEAR_PRIVATE_KEY: `ed25519:${"testkey".repeat(12)}`,
  NEARAI_API_KEY: "sk-test",
  STORAGE_URL: "https://storage.enzure.example",
};

test("the Keeper reads its settings from the environment, with defaults for the rest", () => {
  expect(loadConfig(required)).toEqual({
    oracleAccountId: "oracle.enzure.testnet",
    nearNetwork: "testnet",
    nearRpcUrl: undefined,
    nearAccountId: "keeper.enzure.testnet",
    nearPrivateKey: required.NEAR_PRIVATE_KEY,
    nearAiApiKey: "sk-test",
    nearAiUrl: "https://cloud-api.near.ai/v1",
    storageUrl: "https://storage.enzure.example",
    pollIntervalMs: 15_000,
    relayer: undefined,
  });
});

test("the Relayer is switched on by an EVM RPC URL and key together", () => {
  const config = loadConfig({
    ...required,
    EVM_RPC_URL: "https://sepolia.base.org",
    EVM_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    POLL_INTERVAL_MS: "5000",
  });

  expect(config.relayer).toEqual({
    evmRpcUrl: "https://sepolia.base.org",
    evmPrivateKey: `0x${"11".repeat(32)}`,
  });
  expect(config.pollIntervalMs).toBe(5_000);
});

test("missing or malformed settings are reported by name without echoing secret values", () => {
  const run = () =>
    loadConfig({ ...required, NEAR_PRIVATE_KEY: "not-a-key", STORAGE_URL: undefined });

  expect(run).toThrow(/NEAR_PRIVATE_KEY/);
  expect(run).toThrow(/STORAGE_URL/);
  expect(run).not.toThrow(/not-a-key/);
});

test("an EVM key without an EVM RPC URL is rejected", () => {
  expect(() => loadConfig({ ...required, EVM_PRIVATE_KEY: `0x${"11".repeat(32)}` })).toThrow(
    /EVM_RPC_URL/,
  );
});
