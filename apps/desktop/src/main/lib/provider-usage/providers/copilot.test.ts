import { describe, expect, it } from "bun:test";
import { parseCopilotUsage } from "./copilot";

describe("parseCopilotUsage", () => {
	it("maps premium and chat quota snapshots to monthly windows", () => {
		const usage = parseCopilotUsage({
			copilot_plan: "individual_pro",
			quota_reset_date: "2026-08-01",
			quota_snapshots: {
				premium_interactions: {
					entitlement: 300,
					remaining: 75,
					percent_remaining: 25,
					unlimited: false,
				},
				chat: { unlimited: true },
			},
		});

		expect(usage?.plan).toBe("Individual Pro");
		expect(usage?.windows).toHaveLength(1);
		expect(usage?.windows[0]).toMatchObject({
			id: "premium_interactions",
			label: "Premium requests (monthly)",
			usedPercent: 75,
			resetsAt: Date.parse("2026-08-01"),
			windowDurationMs: null,
		});
	});

	it("derives the percentage from counts when percent_remaining is absent", () => {
		const usage = parseCopilotUsage({
			quota_snapshots: {
				premium_interactions: { entitlement: 200, remaining: 150 },
			},
		});
		expect(usage?.windows[0]?.usedPercent).toBe(25);
	});

	it("drops zeroed placeholder snapshots (token-based billing)", () => {
		expect(
			parseCopilotUsage({
				copilot_plan: "business",
				quota_snapshots: {
					premium_interactions: { entitlement: 0, remaining: 0 },
					chat: { entitlement: 0, remaining: 0 },
				},
			}),
		).toBeNull();
	});

	it("clamps over-quota usage to 100%", () => {
		const usage = parseCopilotUsage({
			quota_snapshots: {
				premium_interactions: { percent_remaining: -12.5 },
			},
		});
		expect(usage?.windows[0]?.usedPercent).toBe(100);
	});

	it("returns null for unrecognized payloads", () => {
		expect(parseCopilotUsage(null)).toBeNull();
		expect(parseCopilotUsage({ quota_snapshots: {} })).toBeNull();
	});
});
