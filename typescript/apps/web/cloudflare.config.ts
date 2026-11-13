import { defineConfig } from "cf/config";

// `--mode mainnet` selects the mainnet Worker. `--mode testnet` and the modes
// cf and Vite pick on their own (development, production, none) select
// testnet, so mainnet is never deployed by accident. vite.config.ts applies
// the same rule to the app's configuration.
const networkOf = (mode: string | undefined): "testnet" | "mainnet" => {
  if (mode === "mainnet") return "mainnet";
  if (mode === undefined || ["testnet", "development", "production", "test"].includes(mode)) {
    return "testnet";
  }
  throw new Error(`Unknown mode "${mode}": use --mode testnet or --mode mainnet`);
};

export default defineConfig(({ mode }) => ({
  worker: {
    // The storage service's CORS list allows https://enzure-web.<subdomain>.workers.dev
    // on testnet and https://enzure-web-mainnet.<subdomain>.workers.dev on mainnet.
    name: networkOf(mode) === "mainnet" ? "enzure-web-mainnet" : "enzure-web",
    compatibilityDate: "2026-11-13",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "@tanstack/react-start/server-entry",
    workersDev: true,
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true },
    },
  },
}));
