import { NEAR_AI_URL } from "@enzure/core";
import * as z from "zod";

const accountId = z.string().regex(/^[a-z0-9._-]{2,64}$/, "must be a NEAR account id");

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
    /** Both EVM settings switch the Relayer on. */
    EVM_RPC_URL: z.url().optional(),
    EVM_PRIVATE_KEY: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x and 64 hex characters")
      .optional(),
  })
  .refine((env) => (env.EVM_RPC_URL === undefined) === (env.EVM_PRIVATE_KEY === undefined), {
    message: "set EVM_RPC_URL and EVM_PRIVATE_KEY together to run the Relayer, or neither",
    path: ["EVM_RPC_URL"],
  });

export type KeeperConfig = ReturnType<typeof loadConfig>;

/**
 * Reads the Keeper's settings from environment variables. Throws an error that
 * names every missing or malformed variable, without echoing their values.
 */
export function loadConfig(env: Record<string, string | undefined>) {
  const parsed = Env.safeParse(env, { reportInput: false });
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message.replace(/, received .*$/, "")}`,
    );
    throw new Error(`invalid Keeper configuration:\n  ${problems.join("\n  ")}`);
  }
  const e = parsed.data;
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
    relayer:
      e.EVM_RPC_URL !== undefined && e.EVM_PRIVATE_KEY !== undefined
        ? { evmRpcUrl: e.EVM_RPC_URL, evmPrivateKey: e.EVM_PRIVATE_KEY as `0x${string}` }
        : undefined,
  };
}
