import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// `--mode mainnet` selects the mainnet Worker. `--mode testnet` and the modes
// cf and Vite pick on their own (development, production, test, none) select
// testnet, so mainnet is never deployed by accident.
const networkOf = (mode: string | undefined): "testnet" | "mainnet" => {
  if (mode === "mainnet") return "mainnet";
  if (mode === undefined || ["testnet", "development", "production", "test"].includes(mode)) {
    return "testnet";
  }
  throw new Error(`Unknown mode "${mode}": use --mode testnet or --mode mainnet`);
};

export default defineConfig(({ mode }) => {
  // Testnet keeps the original names; mainnet's Worker, bucket and web app end in -mainnet.
  const mainnet = networkOf(mode) === "mainnet";
  const suffix = mainnet ? "-mainnet" : "";
  return {
    worker: {
      name: `enzure-storage${suffix}`,
      compatibilityDate: "2026-11-13",
      entrypoint,
      workersDev: true,
      observability: {
        enabled: true,
        logs: { enabled: true, invocationLogs: true },
        traces: { enabled: true },
      },
      env: {
        CONTENT: bindings.r2({ name: `enzure-content${suffix}` }),
        // Per client IP. Workers rate limits are counted per Cloudflare location.
        // Each network has its own namespace, so their counters are separate.
        UPLOAD_LIMITER: bindings.rateLimit({
          namespace: mainnet ? "3002" : "3001",
          simple: { limit: 30, period: 60 },
        }),
        // Origins of the web app (ticket #13) that may call the service from a browser.
        ALLOWED_ORIGINS: bindings.json([
          "http://localhost:3000",
          "http://localhost:5173",
          `https://enzure-web${suffix}.luckzivanius.workers.dev`,
        ]),
      },
    },
  };
});
