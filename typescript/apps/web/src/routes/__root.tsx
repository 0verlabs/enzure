import {
	HeadContent,
	Link,
	Scripts,
	createRootRoute,
} from "@tanstack/react-router";
import { ArrowLeftIcon, SearchXIcon } from "lucide-react";
import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { ConfigAlert, SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WalletProvider } from "@/lib/wallet";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1, viewport-fit=cover",
			},
			{ title: "Enzure" },
			{
				name: "description",
				content:
					"Post, dispute and follow Assertions on the Enzure optimistic oracle on NEAR.",
			},
			{ name: "theme-color", content: "#09090b" },
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{ rel: "icon", href: "/favicon.svg" },
		],
	}),
	notFoundComponent: NotFound,
	shellComponent: RootDocument,
});

function NotFound() {
	return (
		<Empty className="flex-1">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<SearchXIcon />
				</EmptyMedia>
				<EmptyTitle>Page not found</EmptyTitle>
				<EmptyDescription>This page doesn&apos;t exist.</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button variant="outline" nativeButton={false} render={<Link to="/" />}>
					<ArrowLeftIcon data-icon="inline-start" />
					Back to Assertions
				</Button>
			</EmptyContent>
		</Empty>
	);
}

function RootDocument({ children }: { children: ReactNode }) {
	return (
		<html lang="en" className="dark">
			<head>
				<HeadContent />
			</head>
			<body className="min-h-svh bg-background text-foreground antialiased">
				<TooltipProvider>
					<WalletProvider>
						<SidebarProvider>
							<AppSidebar />
							<SidebarInset className="min-w-0">
								<SiteHeader />
								<div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 md:px-10 md:py-10">
									<ConfigAlert />
									{children}
								</div>
							</SidebarInset>
						</SidebarProvider>
					</WalletProvider>
				</TooltipProvider>
				<Scripts />
			</body>
		</html>
	);
}
