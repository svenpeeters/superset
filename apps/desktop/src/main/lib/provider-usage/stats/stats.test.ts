import { describe, expect, it } from "bun:test";
import { parseClaudeUsageEntry } from "./claude-stats";
import { parseCodexSessionTotals } from "./codex-stats";
import {
	addToDayAggregate,
	buildProviderStats,
	type DayAggregate,
	toLocalDateKey,
} from "./daily-aggregation";
import { estimateCostUsd, getModelPricing, totalTokens } from "./pricing";

describe("pricing", () => {
	it("prices known Claude and OpenAI models", () => {
		expect(getModelPricing("claude-opus-4-8")?.inputPerMTok).toBe(5);
		expect(getModelPricing("claude-fable-5")?.outputPerMTok).toBe(50);
		expect(getModelPricing("gpt-5.5")?.inputPerMTok).toBe(1.25);
		expect(getModelPricing("some-unknown-model")).toBeNull();
	});

	it("estimates cost across token categories", () => {
		const cost = estimateCostUsd("claude-opus-4-8", {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheWrite5mTokens: 1_000_000,
			cacheWrite1hTokens: 0,
			cacheReadTokens: 1_000_000,
		});
		// 5 + 25 + 6.25 + 0.5
		expect(cost).toBeCloseTo(36.75, 5);
	});

	it("returns zero cost but counts tokens for unknown models", () => {
		const tokens = {
			inputTokens: 100,
			outputTokens: 50,
			cacheWrite5mTokens: 0,
			cacheWrite1hTokens: 0,
			cacheReadTokens: 25,
		};
		expect(estimateCostUsd("mystery-model", tokens)).toBe(0);
		expect(totalTokens(tokens)).toBe(175);
	});
});

describe("parseClaudeUsageEntry", () => {
	it("parses a project-log usage entry", () => {
		const entry = parseClaudeUsageEntry({
			timestamp: "2026-07-01T13:44:46.397Z",
			uuid: "abc",
			message: {
				id: "msg_1",
				model: "claude-opus-4-8",
				usage: {
					input_tokens: 9665,
					output_tokens: 1041,
					cache_creation_input_tokens: 8374,
					cache_read_input_tokens: 16736,
					cache_creation: {
						ephemeral_1h_input_tokens: 8374,
						ephemeral_5m_input_tokens: 0,
					},
				},
			},
		});
		expect(entry).toMatchObject({
			model: "claude-opus-4-8",
			dedupeKey: "msg_1",
			tokens: {
				inputTokens: 9665,
				outputTokens: 1041,
				cacheWrite5mTokens: 0,
				cacheWrite1hTokens: 8374,
				cacheReadTokens: 16736,
			},
		});
	});

	it("falls back to the total cache-write count without the split", () => {
		const entry = parseClaudeUsageEntry({
			timestamp: "2026-07-01T13:44:46.397Z",
			message: {
				model: "claude-opus-4-8",
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_creation_input_tokens: 100,
				},
			},
		});
		expect(entry?.tokens.cacheWrite5mTokens).toBe(100);
		expect(entry?.tokens.cacheWrite1hTokens).toBe(0);
	});

	it("rejects entries without usage", () => {
		expect(parseClaudeUsageEntry({ type: "user" })).toBeNull();
		expect(parseClaudeUsageEntry(null)).toBeNull();
	});
});

describe("parseCodexSessionTotals", () => {
	it("takes the last cumulative token_count and the turn model", () => {
		const lines = [
			JSON.stringify({
				type: "turn_context",
				payload: { model: "gpt-5.5-codex" },
			}),
			JSON.stringify({
				type: "event_msg",
				payload: {
					type: "token_count",
					info: {
						total_token_usage: {
							input_tokens: 100,
							cached_input_tokens: 40,
							output_tokens: 10,
							total_tokens: 110,
						},
					},
				},
			}),
			JSON.stringify({
				type: "event_msg",
				payload: {
					type: "token_count",
					info: {
						total_token_usage: {
							input_tokens: 18845,
							cached_input_tokens: 2432,
							output_tokens: 226,
							total_tokens: 19071,
						},
					},
				},
			}),
		];
		const totals = parseCodexSessionTotals(lines);
		expect(totals).toMatchObject({
			model: "gpt-5.5-codex",
			totalTokens: 19071,
			tokens: {
				inputTokens: 18845 - 2432,
				outputTokens: 226,
				cacheReadTokens: 2432,
			},
		});
	});

	it("returns null when no token_count events exist", () => {
		expect(parseCodexSessionTotals(["{}", "not json"])).toBeNull();
	});
});

describe("buildProviderStats", () => {
	it("aggregates the last 30 days and finds the top model", () => {
		const now = Date.parse("2026-07-03T12:00:00.000Z");
		const perDay = new Map<string, DayAggregate>();
		addToDayAggregate(perDay, toLocalDateKey(now), 2.5, 1000);
		addToDayAggregate(
			perDay,
			toLocalDateKey(now - 24 * 60 * 60 * 1000),
			1,
			500,
		);
		// Outside the window — must be ignored.
		addToDayAggregate(
			perDay,
			toLocalDateKey(now - 40 * 24 * 60 * 60 * 1000),
			99,
			99999,
		);

		const stats = buildProviderStats({
			perDay,
			latestTokens: 1000,
			modelTokens: new Map([
				["claude-opus-4-8", 1200],
				["claude-haiku-4-5", 300],
			]),
			now,
		});

		expect(stats.daily).toHaveLength(30);
		expect(stats.todayCostUsd).toBeCloseTo(2.5, 5);
		expect(stats.last30dCostUsd).toBeCloseTo(3.5, 5);
		expect(stats.last30dTokens).toBe(1500);
		expect(stats.topModel).toBe("claude-opus-4-8");
		expect(stats.daily.at(-1)?.costUsd).toBeCloseTo(2.5, 5);
	});
});
