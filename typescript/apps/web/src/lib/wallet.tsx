import { ClientOnly } from "@tanstack/react-router";
import { createContext, lazy, Suspense, useContext, useState, type ReactNode } from "react";

/** The result of a signed oracle call: its transaction and the method's return value. */
export interface CallResult {
  transactionHash: string;
  value: unknown;
}

export interface OracleCall {
  method: string;
  args: Record<string, unknown>;
  /** yoctoNEAR */
  deposit: string;
  gas: string;
}

export interface Wallet {
  /** True until the wallet connector has loaded in the browser. */
  loading: boolean;
  /** The connected NEAR account, or null. */
  accountId: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Signs and sends one function call to the oracle. Rejects if it fails. */
  call: (call: OracleCall) => Promise<CallResult>;
}

const notReady = async (): Promise<never> => {
  throw new Error("The wallet is still loading");
};

const loadingWallet: Wallet = {
  loading: true,
  accountId: null,
  signIn: notReady,
  signOut: notReady,
  call: notReady,
};

const WalletContext = createContext<Wallet>(loadingWallet);

// The connector touches browser storage, so it loads only in the browser.
const NearBridge = lazy(() => import("./near-bridge"));

/**
 * Provides the NEAR wallet. On the server, and until the connector has loaded,
 * the wallet is `loading` with no account.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<Wallet>(loadingWallet);
  return (
    <WalletContext.Provider value={wallet}>
      {children}
      <ClientOnly>
        <Suspense>
          <NearBridge onChange={setWallet} />
        </Suspense>
      </ClientOnly>
    </WalletContext.Provider>
  );
}

export function useWallet(): Wallet {
  return useContext(WalletContext);
}
