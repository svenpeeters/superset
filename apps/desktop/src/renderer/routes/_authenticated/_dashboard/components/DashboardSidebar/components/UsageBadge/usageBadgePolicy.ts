import type {
	ProviderUsage,
	ProviderUsageSnapshot,
	UsageWindow,
} from "lib/trpc/routers/provider-usage.schema";

export type UsageSeverity = "normal" | "elevated" | "high";

export function getUsageSeverity(usedPercent: number): UsageSeverity {
	if (usedPercent >= 90) return "high";
	if (usedPercent >= 70) return "elevated";
	return "normal";
}

export function getWorstWindow(usage: ProviderUsage): UsageWindow | null {
	let worst: UsageWindow | null = null;
	for (const window of usage.windows) {
		if (!worst || window.usedPercent > worst.usedPercent) {
			worst = window;
		}
	}
	return worst;
}

export function getActiveProviders(
	snapshot: ProviderUsageSnapshot | undefined,
): ProviderUsage[] {
	if (!snapshot) return [];
	return snapshot.providers.filter(
		(provider) => provider.status === "ok" && provider.windows.length > 0,
	);
}

export function getWorstUtilization(
	snapshot: ProviderUsageSnapshot | undefined,
): number | null {
	let worst: number | null = null;
	for (const provider of getActiveProviders(snapshot)) {
		const window = getWorstWindow(provider);
		if (window && (worst === null || window.usedPercent > worst)) {
			worst = window.usedPercent;
		}
	}
	return worst;
}
