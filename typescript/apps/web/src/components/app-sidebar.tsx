import { Link, useRouterState } from "@tanstack/react-router";
import {
  ArrowDownToLineIcon,
  BookOpenIcon,
  ExternalLinkIcon,
  ListIcon,
  PlusIcon,
  WalletIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Wordmark } from "@/components/brand";
import { TxLink } from "@/components/assertion-bits";
import { ErrorAlert } from "@/components/error-alert";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { config } from "@/config";
import { yoctoToNear } from "@/lib/near-amount";
import { CALL_GAS, oracle } from "@/lib/oracle";
import { useOracleAction } from "@/lib/oracle-action";
import { useWallet } from "@/lib/wallet";

/**
 * The developer docs (Mintlify), which this Worker serves at /docs on whatever
 * domain the app runs on (src/server.ts). The Docs item shows as coming soon while this is null.
 */
const DOCS_URL: string | null = "/docs";

export function AppSidebar() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { setOpenMobile } = useSidebar();
  // On a phone the sidebar is a sheet over the page: close it once a link has moved the page.
  useEffect(() => setOpenMobile(false), [pathname, setOpenMobile]);
  const onList = pathname === "/" || pathname.startsWith("/assertions/");

  return (
    <Sidebar>
      <SidebarHeader className="h-14 flex-row items-center px-4">
        <Link to="/" aria-label="Enzure home" className="flex items-center">
          <Wordmark className="h-4" />
        </Link>
      </SidebarHeader>
      <SidebarSeparator className="mx-0" />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Oracle</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={onList} className="h-9" render={<Link to="/" />}>
                  <ListIcon />
                  Assertions
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname === "/assert"}
                  className="h-9"
                  render={<Link to="/assert" />}
                >
                  <PlusIcon />
                  Post an Assertion
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Developers</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                {DOCS_URL ? (
                  <SidebarMenuButton
                    className="h-9"
                    render={<a href={DOCS_URL} target="_blank" rel="noreferrer" />}
                  >
                    <BookOpenIcon />
                    Docs
                    <ExternalLinkIcon className="ml-auto opacity-60" />
                  </SidebarMenuButton>
                ) : (
                  <>
                    <SidebarMenuButton aria-disabled className="h-9 cursor-default opacity-60">
                      <BookOpenIcon />
                      Docs
                    </SidebarMenuButton>
                    <SidebarMenuBadge>Soon</SidebarMenuBadge>
                  </>
                )}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-3">
        <BalancePanel />
      </SidebarFooter>
    </Sidebar>
  );
}

/** The connected account's withdrawable balance in the oracle, with a Withdraw button. */
function BalancePanel() {
  const wallet = useWallet();
  // The panel stays mounted across pages, so it re-reads the balance on each page change.
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [balance, setBalance] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    if (!wallet.accountId) return setBalance(null);
    setBalance(await oracle.getBalance(wallet.accountId));
  }, [wallet.accountId]);
  const action = useOracleAction(refresh);
  const error = action.error ?? loadError;

  useEffect(() => {
    refresh().catch(setLoadError);
  }, [refresh, pathname]);

  if (wallet.loading) return <Skeleton className="h-24 w-full" />;

  if (!wallet.accountId) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border bg-background p-3">
        <p className="text-xs text-muted-foreground">
          Connect a NEAR {config.network} wallet to post, dispute and withdraw.
        </p>
        <Button onClick={() => void wallet.signIn()}>
          <WalletIcon data-icon="inline-start" />
          Connect wallet
        </Button>
      </div>
    );
  }

  // `withdraw` needs exactly one yoctoNEAR; without an amount it sends the whole balance.
  const withdraw = () => action.run({ method: "withdraw", args: {}, deposit: "1", gas: CALL_GAS });

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-background p-3">
      <div className="flex flex-col gap-1">
        <span className="kicker text-muted-foreground">Withdrawable</span>
        {balance === null ? (
          <Skeleton className="h-7 w-24" />
        ) : (
          <span className="flex items-baseline gap-1.5">
            <span className="font-heading text-2xl font-semibold tabular-nums">
              {yoctoToNear(balance, 4)}
            </span>
            <span className="text-xs text-muted-foreground">NEAR</span>
          </span>
        )}
        <span className="text-xs text-muted-foreground">Returned bonds and dispute payouts.</span>
      </div>
      <Button
        variant="secondary"
        disabled={action.pending || !balance || BigInt(balance) === 0n}
        onClick={withdraw}
      >
        {action.pending ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <ArrowDownToLineIcon data-icon="inline-start" />
        )}
        Withdraw
      </Button>
      {action.sent ? (
        <span className="text-xs text-muted-foreground">
          Sent in <TxLink hash={action.sent.hash} />
        </span>
      ) : null}
      {error ? <ErrorAlert error={error} /> : null}
    </div>
  );
}
