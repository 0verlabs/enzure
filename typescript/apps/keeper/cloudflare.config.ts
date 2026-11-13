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

export default defineConfig({
  worker: {
    name: "enzure-keeper",
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
      NEAR_NETWORK: setting("NEAR_NETWORK"),
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
});
