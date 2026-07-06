import { describe, expect, it } from "bun:test";
import type { ProviderUsageSnapshot } from "lib/trpc/routers/provider-usage.schema";
import { getUsageSeverity, getWorstUtilization } from "./usageBadgePolicy";

function createSnapshot(
	providers: ProviderUsageSnapshot["providers"],
): ProviderUsageSnapshot {
	return { providers, collectedAt: 0 };
}

function createProvider(
	overrides: Partial<ProviderUsageSnapshot["providers"][number]>,
): ProviderUsageSnapshot["providers"][number] {
	return {
		providerId: "claude",
		status: "ok",
		windows: [],
		account: null,
		credits: null,
		manualResetsAvailable: null,
		costUsd: null,
		stats: null,
		fetchedAt: 0,
		dataAsOf: null,
		errorMessage: null,
		...overrides,
	};
}

describe("getUsageSeverity", () => {
	it("maps percentages to severity buckets", () => {
		expect(getUsageSeverity(0)).toBe("normal");
		expect(getUsageSeverity(69.9)).toBe("normal");
		expect(getUsageSeverity(70)).toBe("elevated");
		expect(getUsageSeverity(90)).toBe("high");
	});
});

describe("getWorstUtilization", () => {
	it("returns null when no provider is ok", () => {
		expect(getWorstUtilization(undefined)).toBeNull();
		expect(
			getWorstUtilization(
				createSnapshot([createProvider({ status: "no-credentials" })]),
			),
		).toBeNull();
	});

	it("returns the highest window percentage across ok providers", () => {
		const snapshot = createSnapshot([
			createProvider({
				windows: [
					{
						id: "a",
						label: "A",
						usedPercent: 20,
						resetsAt: null,
						windowDurationMs: null,
					},
					{
						id: "b",
						label: "B",
						usedPercent: 55,
						resetsAt: null,
						windowDurationMs: null,
					},
				],
			}),
			createProvider({
				providerId: "codex",
				windows: [
					{
						id: "c",
						label: "C",
						usedPercent: 80,
						resetsAt: null,
						windowDurationMs: null,
					},
				],
			}),
			createProvider({
				providerId: "gemini",
				status: "error",
				windows: [
					{
						id: "d",
						label: "D",
						usedPercent: 99,
						resetsAt: null,
						windowDurationMs: null,
					},
				],
			}),
		]);
		expect(getWorstUtilization(snapshot)).toBe(80);
	});
});
