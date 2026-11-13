import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite-plus";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

export default defineConfig(({ mode }) => {
  // Configuration is fixed at build time from the environment or the root `.env`.
  // Only these public values reach the bundle; secrets in `.env` don't.
  const env = { ...loadEnv(mode, repoRoot, ""), ...process.env };
  const config = {
    oracleAccountId: env.ORACLE_ACCOUNT_ID ?? "",
    storageUrl: env.STORAGE_URL ?? "",
    network: env.NEAR_NETWORK ?? "testnet",
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
