import { NEAR_AI_URL } from "@enzure/core";
import * as z from "zod";
import {
  RELAYER_CHAIN_NAMES,
  RELAYER_CHAINS,
  relayerVariables,
  type RelayerChainName,
  type RelayerVariable,
} from "./chains.ts";

const accountId = z.string().regex(/^[a-z0-9._-]{2,64}$/, "must be a NEAR account id");
const evmKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x and 64 hex characters");

const Env = z
  .object({
    ORACLE_ACCOUNT_ID: accountId,
    NEAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
    NEAR_RPC_URL: z.url().optional(),
    /** The account that signs `settle`, `check_timeout`, `sign_hook` and `submit_ai_verdict`. */
    NEAR_ACCOUNT_ID: accountId,
    NEAR_PRIVATE_KEY: z
      .string()
      .regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,90}$/, "must be ed25519:<base58>"),
    NEARAI_API_KEY: z.string().min(1),
    NEAR_AI_URL: z.url().default(NEAR_AI_URL),
    STORAGE_URL: z.url(),
    POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
  })
  // One <NAME>_RPC_URL and <NAME>_RELAYER_KEY per chain in RELAYER_CHAINS.
  .extend(
    Object.fromEntries(
      RELAYER_CHAIN_NAMES.flatMap((chain) => {
        const names = relayerVariables(chain);
        return [
          [names.rpcUrl, z.url().optional()],
          [names.key, evmKey.optional()],
        ];
      }),
    ) as Record<RelayerVariable, z.ZodOptional<z.ZodString>>,
  )
  .superRefine((env, ctx) => {
    for (const chain of RELAYER_CHAIN_NAMES) {
      const names = relayerVariables(chain);
      if ((env[names.rpcUrl] === undefined) !== (env[names.key] === undefined)) {
        ctx.addIssue({
          code: "custom",
          message: `set ${names.rpcUrl} and ${names.key} together to relay to ${chain}, or neither`,
          path: [names.rpcUrl],
        });
      }
    }
  });

/** One chain the Relayer delivers to. */
export interface RelayerConfig {
  chain: RelayerChainName;
  kind: (typeof RELAYER_CHAINS)[RelayerChainName]["kind"];
  /** The chain ids its RPC may report. */
  chainIds: readonly number[];
  rpcUrl: string;
  /** Pays the gas for deliveries on this chain. */
  privateKey: `0x${string}`;
}

export type KeeperConfig = ReturnType<typeof loadConfig>;

/**
 * Reads the Keeper's settings from environment variables or Worker bindings.
 * Throws an error that names every missing or malformed variable, without
 * echoing their values. Empty values count as unset.
 */
export function loadConfig(env: Record<string, unknown>) {
  const given = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const parsed = Env.safeParse(given, { reportInput: false });
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message.replace(/, received .*$/, "")}`,
    );
    throw new Error(`invalid Keeper configuration:\n  ${problems.join("\n  ")}`);
  }
  const e = parsed.data;
  const relayers = RELAYER_CHAIN_NAMES.flatMap((chain): RelayerConfig[] => {
    const names = relayerVariables(chain);
    const rpcUrl = e[names.rpcUrl];
    const privateKey = e[names.key];
    if (rpcUrl === undefined || privateKey === undefined) return [];
    const { kind, chainIds } = RELAYER_CHAINS[chain];
    return [{ chain, kind, chainIds, rpcUrl, privateKey: privateKey as `0x${string}` }];
  });
  return {
    oracleAccountId: e.ORACLE_ACCOUNT_ID,
    nearNetwork: e.NEAR_NETWORK,
    nearRpcUrl: e.NEAR_RPC_URL,
    nearAccountId: e.NEAR_ACCOUNT_ID,
    nearPrivateKey: e.NEAR_PRIVATE_KEY as `ed25519:${string}`,
    nearAiApiKey: e.NEARAI_API_KEY,
    nearAiUrl: e.NEAR_AI_URL,
    storageUrl: e.STORAGE_URL,
    pollIntervalMs: e.POLL_INTERVAL_MS,
    relayers,
  };
}
