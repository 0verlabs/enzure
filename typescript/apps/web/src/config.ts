import { z } from "zod";

declare const __ENZURE_WEB_CONFIG__: Record<string, string>;

const NETWORK_DEFAULTS = {
  testnet: {
    rpcUrl: "https://test.rpc.fastnear.com",
    txApiUrl: "https://tx.test.fastnear.com",
    explorerUrl: "https://testnet.nearblocks.io",
  },
  mainnet: {
    rpcUrl: "https://free.rpc.fastnear.com",
    txApiUrl: "https://tx.main.fastnear.com",
    explorerUrl: "https://nearblocks.io",
  },
} as const;

const url = z.url().transform((value) => value.replace(/\/$/, ""));

const schema = z
  .object({
    oracleAccountId: z.string(),
    storageUrl: z.union([url, z.literal("")]),
    network: z.enum(["testnet", "mainnet"]),
    rpcUrl: z.union([url, z.literal("")]),
    txApiUrl: z.union([url, z.literal("")]),
    explorerUrl: z.union([url, z.literal("")]),
  })
  .transform((raw) => {
    const defaults = NETWORK_DEFAULTS[raw.network];
    return {
      oracleAccountId: raw.oracleAccountId,
      storageUrl: raw.storageUrl,
      network: raw.network,
      rpcUrl: raw.rpcUrl || defaults.rpcUrl,
      txApiUrl: raw.txApiUrl || defaults.txApiUrl,
      explorerUrl: raw.explorerUrl || defaults.explorerUrl,
    };
  });

/**
 * The app's configuration, fixed at build time from `ORACLE_ACCOUNT_ID`,
 * `STORAGE_URL`, `NEAR_NETWORK` and the optional `NEAR_RPC_URL`,
 * `NEAR_TX_API_URL` and `NEAR_EXPLORER_URL` (see `vite.config.ts`).
 */
export const config = schema.parse(__ENZURE_WEB_CONFIG__);

/** What is missing for the app to work, if anything. */
export const missingConfig = [
  ...(config.oracleAccountId ? [] : ["ORACLE_ACCOUNT_ID"]),
  ...(config.storageUrl ? [] : ["STORAGE_URL"]),
];

export const transactionUrl = (hash: string) => `${config.explorerUrl}/txns/${hash}`;
export const accountUrl = (accountId: string) => `${config.explorerUrl}/address/${accountId}`;
