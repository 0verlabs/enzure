import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ConfigAlert, SiteHeader } from "@/components/site-header";
import { WalletProvider } from "@/lib/wallet";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Enzure" },
      {
        name: "description",
        content: "Post, dispute and follow Assertions on the Enzure optimistic oracle on NEAR.",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico" },
    ],
  }),
  notFoundComponent: () => (
    <div className="flex flex-col gap-2">
      <h1 className="text-lg font-medium">Not found</h1>
      <p className="text-muted-foreground">This page doesn&apos;t exist.</p>
    </div>
  ),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-svh bg-background text-foreground antialiased">
        <WalletProvider>
          <SiteHeader />
          <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8">
            <ConfigAlert />
            {children}
          </main>
        </WalletProvider>
        <Scripts />
      </body>
    </html>
  );
}
