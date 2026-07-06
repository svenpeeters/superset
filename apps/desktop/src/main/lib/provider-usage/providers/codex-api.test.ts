import { describe, expect, it } from "bun:test";
import { parseWhamUsage } from "./codex-api";

// Mirrors a real wham/usage response shape.
const WHAM_RESPONSE = {
	email: "user@example.com",
	plan_type: "prolite",
	rate_limit: {
		allowed: true,
		primary_window: {
			used_percent: 12.5,
			limit_window_seconds: 18000,
			reset_after_seconds: 3600,
			reset_at: 1783109508,
		},
		secondary_window: {
			used_percent: 11,
			limit_window_seconds: 604800,
			reset_at: 1783396632,
		},
	},
	additional_rate_limits: [
		{
			limit_name: "GPT-5.3-Codex-Spark",
			metered_feature: "codex_bengalfox",
			rate_limit: {
				primary_window: {
					used_percent: 0,
					limit_window_seconds: 18000,
					reset_at: 1783109508,
				},
				secondary_window: {
					used_percent: 3,
					limit_window_seconds: 604800,
					reset_at: 1783696308,
				},
			},
		},
	],
	credits: { has_credits: true, unlimited: false, balance: "3934.0055875000" },
	rate_limit_reset_credits: { available_count: 4 },
};

describe("parseWhamUsage", () => {
	it("maps the live usage response to windows, credits, and account", () => {
		const usage = parseWhamUsage(WHAM_RESPONSE);
		expect(usage).not.toBeNull();
		expect(usage?.email).toBe("user@example.com");
		expect(usage?.plan).toBe("prolite");
		expect(usage?.manualResetsAvailable).toBe(4);
		expect(usage?.credits).toEqual({
			balance: 3934.0055875,
			currency: "credits",
		});

		expect(usage?.windows.map((w) => w.label)).toEqual([
			"5-hour session",
			"Weekly",
			"Codex Spark 5-hour session",
			"Codex Spark Weekly",
		]);
		const primary = usage?.windows[0];
		expect(primary?.usedPercent).toBe(12.5);
		expect(primary?.resetsAt).toBe(1783109508 * 1000);
		expect(primary?.windowDurationMs).toBe(18000 * 1000);
	});

	it("returns null when no windows are present", () => {
		expect(parseWhamUsage({ email: "x@y.z" })).toBeNull();
		expect(parseWhamUsage(null)).toBeNull();
		expect(parseWhamUsage("nope")).toBeNull();
	});
});
