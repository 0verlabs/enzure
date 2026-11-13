import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon, LogOutIcon, WalletIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { accountUrl, config, missingConfig } from "@/config";
import { useWallet } from "@/lib/wallet";

export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 w-full max-w-4xl items-center gap-6 px-4">
        <Link to="/" className="font-semibold">
          Enzure
        </Link>
        <nav className="flex items-center gap-4 text-sm text-muted-foreground">
          <Link
            to="/"
            activeOptions={{ exact: true }}
            activeProps={{ className: "text-foreground" }}
          >
            Assertions
          </Link>
          <Link to="/assert" activeProps={{ className: "text-foreground" }}>
            Post
          </Link>
        </nav>
        <div className="ml-auto">
          <WalletButton />
        </div>
      </div>
    </header>
  );
}

function WalletButton() {
  const wallet = useWallet();
  if (wallet.loading) {
    return (
      <Button variant="outline" size="sm" disabled>
        <Spinner data-icon="inline-start" />
        Wallet
      </Button>
    );
  }
  if (!wallet.accountId) {
    return (
      <Button size="sm" onClick={() => void wallet.signIn()}>
        <WalletIcon data-icon="inline-start" />
        Connect {config.network} wallet
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      <a
        href={accountUrl(wallet.accountId)}
        target="_blank"
        rel="noreferrer"
        className="max-w-48 truncate"
      >
        {wallet.accountId}
      </a>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Disconnect"
        onClick={() => void wallet.signOut()}
      >
        <LogOutIcon />
      </Button>
    </div>
  );
}

/** Says which build-time variables are missing, so a misconfigured deploy is obvious. */
export function ConfigAlert() {
  if (missingConfig.length === 0) return null;
  return (
    <Alert variant="destructive">
      <AlertTriangleIcon />
      <AlertTitle>The app isn&apos;t configured</AlertTitle>
      <AlertDescription>
        Set {missingConfig.join(" and ")} when building the app (see apps/web/README.md).
      </AlertDescription>
    </Alert>
  );
}
