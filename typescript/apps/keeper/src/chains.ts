/**
 * The chains the Relayer can deliver to. Each one is switched on by
 * `<NAME>_RPC_URL` and `<NAME>_RELAYER_KEY`, set together. `chainIds` are the
 * ids its RPC may report (mainnet and testnet), so an RPC for another chain is
 * refused instead of relaying Hooks meant elsewhere.
 *
 * Adding a chain: see "Add a Relayer chain" in the README. Another EVM chain is
 * one entry here; a chain of another kind (Solana) also needs a relayer for
 * that kind in @enzure/core and a branch for it in `keeper.ts`.
 */
export const RELAYER_CHAINS = {
  // Base mainnet and Base Sepolia. A local anvil started with --chain-id 84532 passes as Base Sepolia.
  BASE: { kind: "evm", chainIds: [8453, 84532] },
} as const satisfies Record<string, { kind: "evm"; chainIds: readonly number[] }>;

export type RelayerChainName = keyof typeof RELAYER_CHAINS;

export const RELAYER_CHAIN_NAMES = Object.keys(RELAYER_CHAINS) as RelayerChainName[];

/** The two variables that switch on relaying to `chain`. */
export function relayerVariables<C extends RelayerChainName>(chain: C) {
  return { rpcUrl: `${chain}_RPC_URL`, key: `${chain}_RELAYER_KEY` } as const;
}

/** Every chain's `<NAME>_RPC_URL` and `<NAME>_RELAYER_KEY`. */
export type RelayerVariable = `${RelayerChainName}_${"RPC_URL" | "RELAYER_KEY"}`;
