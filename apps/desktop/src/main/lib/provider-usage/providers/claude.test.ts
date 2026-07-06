import { describe, expect, it } from "bun:test";
import { mapClaudeUsageWindows, rateLimitCooldownMs } from "./claude";

describe("mapClaudeUsageWindows", () => {
	it("maps utilization buckets to usage windows", () => {
		const windows = mapClaudeUsageWindows({
			five_hour: { utilization: 37, resets_at: "2026-07-03T12:00:00+00:00" },
			seven_day: { utilization: 61.2, resets_at: "2026-07-07T00:00:00+00:00" },
			seven_day_opus: null,
		});

		expect(windows).toHaveLength(2);
		expect(windows?.[0]).toMatchObject({
			id: "five_hour",
			label: "5-hour session",
			usedPercent: 37,
			resetsAt: Date.parse("2026-07-03T12:00:00+00:00"),
			windowDurationMs: 5 * 60 * 60 * 1000,
		});
		expect(windows?.[1]?.usedPercent).toBe(61.2);
		expect(windows?.[1]?.windowDurationMs).toBe(7 * 24 * 60 * 60 * 1000);
	});

	it("maps unknown buckets generically", () => {
		const windows = mapClaudeUsageWindows({
			daily_routines: { utilization: 12 },
		});
		expect(windows?.[0]).toMatchObject({
			id: "daily_routines",
			label: "Daily Routines",
			usedPercent: 12,
			resetsAt: null,
			windowDurationMs: null,
		});
	});

	it("clamps utilization to 0-100", () => {
		const windows = mapClaudeUsageWindows({ five_hour: { utilization: 120 } });
		expect(windows?.[0]?.usedPercent).toBe(100);
	});

	it("returns null for unrecognized payloads", () => {
		expect(mapClaudeUsageWindows(null)).toBeNull();
		expect(mapClaudeUsageWindows("nope")).toBeNull();
		expect(
			mapClaudeUsageWindows({ five_hour: null, seven_day: null }),
		).toBeNull();
	});
});

describe("rateLimitCooldownMs", () => {
	it("honors a numeric Retry-After header", () => {
		expect(rateLimitCooldownMs("120")).toBe(120_000);
	});

	it("caps excessive Retry-After values", () => {
		expect(rateLimitCooldownMs("86400")).toBe(30 * 60_000);
	});

	it("falls back to the default cooldown for missing or non-numeric headers", () => {
		expect(rateLimitCooldownMs(null)).toBe(5 * 60_000);
		expect(rateLimitCooldownMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(
			5 * 60_000,
		);
		expect(rateLimitCooldownMs("0")).toBe(5 * 60_000);
		expect(rateLimitCooldownMs("-5")).toBe(5 * 60_000);
	});
});
