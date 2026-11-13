import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite-plus";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

// The same rule as cloudflare.config.ts: only `--mode mainnet` builds for mainnet.
const networkOf = (mode: string): "testnet" | "mainnet" => {
  if (mode === "mainnet") return "mainnet";
  if (["testnet", "development", "production", "test"].includes(mode)) return "testnet";
  throw new Error(`Unknown mode "${mode}": use --mode testnet or --mode mainnet`);
};

// Variables from a file in the repository root, or none if it doesn't exist.
const envFile = (name: string) => {
  const path = `${repoRoot}/${name}`;
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
};

export default defineConfig(({ mode }) => {
  // Configuration is fixed at build time from the environment or the root env
  // files: on testnet `.env` and `.env.testnet` (Vite's loadEnv, which also
  // reads their `.local` variants), on mainnet `.env.mainnet` only, so testnet
  // values in `.env` never reach a mainnet build.
  // Only these public values reach the bundle; secrets in the files don't.
  const network = networkOf(mode);
  const env = {
    ...(network === "mainnet" ? envFile(".env.mainnet") : loadEnv("testnet", repoRoot, "")),
    ...process.env,
  };
  if (env.NEAR_NETWORK && env.NEAR_NETWORK !== network) {
    throw new Error(`NEAR_NETWORK is ${env.NEAR_NETWORK}, but this is a ${network} build`);
  }
  const config = {
    oracleAccountId: env.ORACLE_ACCOUNT_ID ?? "",
    storageUrl: env.STORAGE_URL ?? "",
    network,
    rpcUrl: env.NEAR_RPC_URL ?? "",
    txApiUrl: env.NEAR_TX_API_URL ?? "",
    explorerUrl: env.NEAR_EXPLORER_URL ?? "",
    evmRpcUrl: env.EVM_RPC_URL ?? "",
    evmLogsApiUrl: env.EVM_LOGS_API_URL ?? "",
    evmExplorerUrl: env.EVM_EXPLORER_URL ?? "",
  };
  return {
    define: { __ENZURE_WEB_CONFIG__: JSON.stringify(config) },
    resolve: {
      tsconfigPaths: true,
      alias: {
        // Bundle core from source, so builds don't need core built first.
        "@enzure/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      },
    },
    server: { port: 3000 },
    plugins: [
      cloudflare({ viteEnvironment: { name: "ssr" } }),
      tailwindcss(),
      tanstackStart(),
      viteReact(),
    ],
  };
});
