import { Link, useRouterState } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  LogOutIcon,
  WalletIcon,
} from "lucide-react";
import { Fragment, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { accountUrl, config, missingConfig } from "@/config";
import { useWallet } from "@/lib/wallet";

/** Where the page sits, from its path: the app has three kinds of page. */
function crumbsFor(pathname: string): { label: string; to?: "/" }[] {
  if (pathname === "/assert") return [{ label: "Assertions", to: "/" }, { label: "Post" }];
  const id = /^\/assertions\/(\d+)/.exec(pathname)?.[1];
  if (id) return [{ label: "Assertions", to: "/" }, { label: `Assertion ${id}` }];
  return [{ label: "Assertions" }];
}

/** The bar above every page: the sidebar toggle, where you are, the network and the wallet. */
export function SiteHeader() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const crumbs = crumbsFor(pathname);
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-center" />
      <Breadcrumb>
        <BreadcrumbList>
          {crumbs.map((crumb, index) => (
            <Fragment key={crumb.label}>
              {index > 0 ? <BreadcrumbSeparator /> : null}
              <BreadcrumbItem>
                {crumb.to ? (
                  <BreadcrumbLink render={<Link to={crumb.to} />}>{crumb.label}</BreadcrumbLink>
                ) : (
                  <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto flex items-center gap-2">
        <Badge variant="outline" className="hidden font-mono sm:inline-flex">
          <span className="size-1.5 rounded-full bg-primary" />
          {config.network}
        </Badge>
        <WalletButton />
      </div>
    </header>
  );
}

function WalletButton() {
  const wallet = useWallet();
  const [copied, setCopied] = useState(false);

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
        Connect wallet
      </Button>
    );
  }
  const accountId = wallet.accountId;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="max-w-56" />}>
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />
        <span className="truncate font-mono text-xs">{accountId}</span>
        <ChevronDownIcon data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate font-mono">{accountId}</DropdownMenuLabel>
          <DropdownMenuItem
            closeOnClick={false}
            onClick={() => {
              void navigator.clipboard.writeText(accountId);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy account ID"}
          </DropdownMenuItem>
          <DropdownMenuItem
            render={<a href={accountUrl(accountId)} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon />
            Open in NearBlocks
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem variant="destructive" onClick={() => void wallet.signOut()}>
            <LogOutIcon />
            Disconnect
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
