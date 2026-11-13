import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/worker.ts" with { type: "cf-worker" };

// This file runs in Node, but it is type-checked with the Worker (tsconfig.worker.json).
declare const process: { env: Record<string, string | undefined> };

// Plain settings come from the environment when the config is evaluated
// (scripts/deploy-keeper.sh loads them from the root .env); unset ones are
// left out and the Keeper's defaults apply. Keys and RPC URLs, which can
// carry provider API keys, are secrets, uploaded by the deploy script.
const setting = (name: string) => {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : bindings.text(value);
};

// Declared secrets must be set for a deploy to succeed, so a Relayer chain's
// secrets (<NAME>_RPC_URL and <NAME>_RELAYER_KEY) are declared only when its key
// is in the environment at deploy time. The Keeper ignores names it has no
// chain for (src/chains.ts). Nothing here imports src/ except the entrypoint:
// the dev server can't load a Worker module that this file also loads.
const relayerSecrets = Object.fromEntries(
  Object.keys(process.env)
    .flatMap((name) => /^([A-Z][A-Z0-9]*)_RELAYER_KEY$/.exec(name)?.[1] ?? [])
    .filter((chain) => process.env[`${chain}_RELAYER_KEY`])
    .flatMap((chain) => [
      [`${chain}_RPC_URL`, bindings.secret()],
      [`${chain}_RELAYER_KEY`, bindings.secret()],
    ]),
);

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
  const network = networkOf(mode);
  // A NEAR_NETWORK in the environment must agree with the mode, so a testnet
  // .env can't point a mainnet Keeper at testnet, or the other way round.
  if (process.env.NEAR_NETWORK && process.env.NEAR_NETWORK !== network) {
    throw new Error(`NEAR_NETWORK is ${process.env.NEAR_NETWORK}, but this is a ${network} build`);
  }
  return {
    worker: {
      // Testnet keeps the original name.
      name: network === "mainnet" ? "enzure-keeper-mainnet" : "enzure-keeper",
      compatibilityDate: "2026-11-13",
      compatibilityFlags: ["nodejs_compat"],
      entrypoint,
      // No public URL: the Keeper runs on its alarm and cron trigger only.
      workersDev: false,
      observability: {
        enabled: true,
        logs: { enabled: true, invocationLogs: true },
        traces: { enabled: true },
      },
      exports: {
        Keeper: exports.durableObject({ storage: "sqlite" }),
      },
      // Restarts the alarm loop if it isn't running (src/worker.ts).
      triggers: [triggers.scheduled({ schedule: "* * * * *" })],
      env: {
        ORACLE_ACCOUNT_ID: setting("ORACLE_ACCOUNT_ID"),
        NEAR_ACCOUNT_ID: setting("NEAR_ACCOUNT_ID"),
        NEAR_NETWORK: bindings.text(network),
        NEAR_AI_URL: setting("NEAR_AI_URL"),
        STORAGE_URL: setting("STORAGE_URL"),
        POLL_INTERVAL_MS: setting("POLL_INTERVAL_MS"),
        NEAR_PRIVATE_KEY: bindings.secret(),
        NEARAI_API_KEY: bindings.secret(),
        // Optional, so declared only when set at deploy time; a secret like the other RPC URLs.
        NEAR_RPC_URL: process.env.NEAR_RPC_URL ? bindings.secret() : undefined,
        ...relayerSecrets,
      },
    },
  };
});
