import { describe, expect, it } from "bun:test";
import { parseCodexAccount, parseCodexRateLimits } from "./codex";

const RATE_LIMIT_EVENT = JSON.stringify({
	timestamp: "2026-07-03T10:00:00.000Z",
	type: "event_msg",
	payload: {
		type: "token_count",
		rate_limits: {
			plan_type: "pro",
			primary: {
				used_percent: 42.5,
				window_minutes: 300,
				resets_at: 1783090800,
			},
			secondary: {
				used_percent: 12,
				window_minutes: 10080,
				resets_in_seconds: 86400,
			},
		},
	},
});

describe("parseCodexRateLimits", () => {
	it("maps the newest rate_limits event to usage windows", () => {
		const lines = [
			JSON.stringify({ type: "event_msg", payload: { type: "agent_message" } }),
			RATE_LIMIT_EVENT,
		];
		const parsed = parseCodexRateLimits(lines);
		expect(parsed).not.toBeNull();
		expect(parsed?.windows).toHaveLength(2);
		expect(parsed?.plan).toBe("Pro");

		const [primary, secondary] = parsed?.windows ?? [];
		expect(primary?.id).toBe("primary");
		expect(primary?.label).toBe("5-hour session");
		expect(primary?.usedPercent).toBe(42.5);
		// resets_at is epoch seconds
		expect(primary?.resetsAt).toBe(1783090800 * 1000);
		expect(primary?.windowDurationMs).toBe(300 * 60_000);
		expect(secondary?.label).toBe("Weekly");
		// resets_in_seconds is relative to the event timestamp
		expect(secondary?.resetsAt).toBe(
			Date.parse("2026-07-03T10:00:00.000Z") + 86400 * 1000,
		);
		expect(parsed?.dataAsOf).toBe(Date.parse("2026-07-03T10:00:00.000Z"));
	});

	it("prefers the last matching event in the file", () => {
		const older = JSON.stringify({
			timestamp: "2026-07-03T08:00:00.000Z",
			payload: {
				type: "token_count",
				rate_limits: { primary: { used_percent: 10 }, secondary: null },
			},
		});
		const parsed = parseCodexRateLimits([older, RATE_LIMIT_EVENT]);
		expect(parsed?.windows[0]?.usedPercent).toBe(42.5);
	});

	it("supports top-level rate_limits events and clamps percentages", () => {
		const line = JSON.stringify({
			timestamp: "2026-07-03T09:30:00.000Z",
			type: "token_count",
			rate_limits: {
				primary: { used_percent: 150, resets_in_seconds: 60 },
				secondary: null,
			},
		});
		const parsed = parseCodexRateLimits([line]);
		expect(parsed?.windows).toHaveLength(1);
		expect(parsed?.windows[0]?.usedPercent).toBe(100);
		expect(parsed?.windows[0]?.label).toBe("Session");
		expect(parsed?.plan).toBeNull();
	});

	it("skips truncated and irrelevant lines", () => {
		const lines = [
			'{"timestamp":"2026-07-03T07:00:00.000Z","payload":{"rate_lim',
			"not json at all",
			JSON.stringify({ payload: { rate_limits: { primary: null } } }),
		];
		expect(parseCodexRateLimits(lines)).toBeNull();
	});

	it("returns null for empty input", () => {
		expect(parseCodexRateLimits([])).toBeNull();
	});
});

describe("parseCodexAccount", () => {
	it("extracts email and plan from the id_token claims", () => {
		const claims = {
			email: "user@example.com",
			"https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
		};
		const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
		const raw = JSON.stringify({
			tokens: { id_token: `header.${payload}.signature` },
		});

		const account = parseCodexAccount(raw);
		expect(account?.email).toBe("user@example.com");
		expect(account?.plan).toBe("Plus");
	});

	it("returns null for invalid auth files", () => {
		expect(parseCodexAccount("not json")).toBeNull();
		expect(parseCodexAccount("{}")).toBeNull();
		expect(
			parseCodexAccount(JSON.stringify({ tokens: { id_token: "garbage" } })),
		).toBeNull();
	});
});
