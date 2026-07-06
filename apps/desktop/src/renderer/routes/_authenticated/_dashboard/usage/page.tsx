import { Button } from "@superset/ui/button";
import { cn } from "@superset/ui/utils";
import { createFileRoute } from "@tanstack/react-router";
import type {
	ProviderUsage,
	ProviderUsageStatus,
} from "lib/trpc/routers/provider-usage.schema";
import { useEffect, useMemo, useState } from "react";
import { HiOutlineArrowPath } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { DormantProvidersStrip } from "./components/DormantProvidersStrip";
import { ProviderUsageCard } from "./components/ProviderUsageCard";
import { UsageSettingsMenu } from "./components/UsageSettingsMenu";

export const Route = createFileRoute("/_authenticated/_dashboard/usage/")({
	component: UsagePage,
});

const STATUS_ORDER: Record<ProviderUsageStatus, number> = {
	ok: 0,
	"auth-expired": 1,
	"no-credentials": 2,
	error: 3,
	unsupported: 4,
};

function sortProviders(providers: ProviderUsage[]): ProviderUsage[] {
	return [...providers].sort(
		(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
	);
}

function useNow(intervalMs: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
}

function UsagePage() {
	const now = useNow(30_000);
	const utils = electronTrpc.useUtils();
	const [isForceRefreshing, setIsForceRefreshing] = useState(false);

	const { data: snapshot, isFetching } =
		electronTrpc.providerUsage.getSnapshot.useQuery(
			{ mode: "interactive" },
			{ refetchInterval: 30_000 },
		);

	const handleRefresh = async () => {
		setIsForceRefreshing(true);
		try {
			// Bypass the main-process cache, then let the query pick up the
			// freshly cached snapshot.
			await utils.client.providerUsage.getSnapshot.query({
				mode: "interactive",
				force: true,
			});
			await utils.providerUsage.getSnapshot.invalidate();
		} finally {
			setIsForceRefreshing(false);
		}
	};

	const providers = useMemo(
		() => sortProviders(snapshot?.providers ?? []),
		[snapshot],
	);
	const activeProviders = providers.filter((p) => p.status !== "unsupported");
	const dormantProviders = providers.filter((p) => p.status === "unsupported");

	return (
		<div className="flex h-full w-full flex-1 flex-col overflow-hidden font-mono">
			<header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
				<h1 className="text-sm font-semibold">Token Usage</h1>
				<div className="flex items-center gap-1">
					<UsageSettingsMenu />
					<Button
						variant="ghost"
						size="sm"
						className="h-8 text-muted-foreground"
						onClick={handleRefresh}
						disabled={isForceRefreshing}
					>
						<HiOutlineArrowPath
							className={cn(
								"size-3.5",
								(isForceRefreshing || isFetching) && "animate-spin",
							)}
						/>
						Refresh
					</Button>
				</div>
			</header>

			<div className="flex-1 overflow-y-auto p-4">
				{providers.length === 0 ? (
					<div className="py-12 text-center text-xs text-muted-foreground">
						Loading usage…
					</div>
				) : (
					<div className="mx-auto flex max-w-3xl flex-col gap-3">
						{activeProviders.map((usage) => (
							<ProviderUsageCard
								key={usage.providerId}
								usage={usage}
								now={now}
							/>
						))}
						<DormantProvidersStrip providers={dormantProviders} />
					</div>
				)}
			</div>
		</div>
	);
}
