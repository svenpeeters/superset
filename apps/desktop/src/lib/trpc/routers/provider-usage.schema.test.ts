import { describe, expect, it } from "bun:test";
import {
	createFallbackProviderUsageSnapshot,
	validateProviderUsageSnapshot,
} from "./provider-usage.schema";

describe("validateProviderUsageSnapshot", () => {
	it("accepts a valid snapshot", () => {
		const snapshot = {
			providers: [
				{
					providerId: "claude",
					status: "ok",
					windows: [
						{
							id: "five_hour",
							label: "5-hour session",
							usedPercent: 42,
							resetsAt: 1780000000000,
							windowDurationMs: 18000000,
						},
					],
					account: { email: "user@example.com", plan: "Max" },
					credits: null,
					manualResetsAvailable: null,
					costUsd: null,
					stats: {
						todayCostUsd: 2.5,
						last30dCostUsd: 100,
						last30dTokens: 5000000,
						latestTokens: 12345,
						daily: [{ date: "2026-07-03", costUsd: 2.5, tokens: 100 }],
						topModel: "claude-opus-4-8",
					},
					fetchedAt: 1770000000000,
					dataAsOf: null,
					errorMessage: null,
				},
			],
			collectedAt: 1770000000000,
		};

		const result = validateProviderUsageSnapshot(snapshot);
		expect(result.isValid).toBe(true);
		expect(result.snapshot.providers).toHaveLength(1);
	});

	it("rejects unknown provider ids and returns the fallback", () => {
		const result = validateProviderUsageSnapshot({
			providers: [{ providerId: "not-an-agent" }],
			collectedAt: 0,
		});
		expect(result.isValid).toBe(false);
		expect(result.issues.length).toBeGreaterThan(0);
		expect(result.snapshot.providers.length).toBeGreaterThan(0);
	});

	it("rejects out-of-range percentages", () => {
		const fallback = createFallbackProviderUsageSnapshot();
		const invalid = {
			...fallback,
			providers: [
				{
					...fallback.providers[0],
					status: "ok",
					windows: [{ id: "w", label: "W", usedPercent: 250, resetsAt: null }],
				},
			],
		};
		expect(validateProviderUsageSnapshot(invalid).isValid).toBe(false);
	});

	it("builds a fallback snapshot covering every agent", () => {
		const fallback = createFallbackProviderUsageSnapshot();
		expect(fallback.providers.length).toBeGreaterThanOrEqual(10);
		expect(validateProviderUsageSnapshot(fallback).isValid).toBe(true);
	});
});
