import type { DailyStat, ProviderStats } from "../types";

export const STATS_WINDOW_DAYS = 30;

export interface DayAggregate {
	costUsd: number;
	tokens: number;
}

export function toLocalDateKey(timestampMs: number): string {
	const date = new Date(timestampMs);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function addToDayAggregate(
	perDay: Map<string, DayAggregate>,
	dateKey: string,
	costUsd: number,
	tokens: number,
): void {
	const existing = perDay.get(dateKey);
	if (existing) {
		existing.costUsd += costUsd;
		existing.tokens += tokens;
	} else {
		perDay.set(dateKey, { costUsd, tokens });
	}
}

export function mergeDayAggregates(
	target: Map<string, DayAggregate>,
	source: Map<string, DayAggregate>,
): void {
	for (const [dateKey, aggregate] of source) {
		addToDayAggregate(target, dateKey, aggregate.costUsd, aggregate.tokens);
	}
}

export function buildProviderStats({
	perDay,
	latestTokens,
	modelTokens,
	now,
}: {
	perDay: Map<string, DayAggregate>;
	latestTokens: number;
	modelTokens: Map<string, number>;
	now: number;
}): ProviderStats {
	const daily: DailyStat[] = [];
	let last30dCostUsd = 0;
	let last30dTokens = 0;

	for (let daysAgo = STATS_WINDOW_DAYS - 1; daysAgo >= 0; daysAgo--) {
		const dateKey = toLocalDateKey(now - daysAgo * 24 * 60 * 60 * 1000);
		const aggregate = perDay.get(dateKey);
		const costUsd = aggregate?.costUsd ?? 0;
		const tokens = aggregate?.tokens ?? 0;
		daily.push({ date: dateKey, costUsd, tokens });
		last30dCostUsd += costUsd;
		last30dTokens += tokens;
	}

	let topModel: string | null = null;
	let topModelTokens = 0;
	for (const [model, tokens] of modelTokens) {
		if (tokens > topModelTokens) {
			topModel = model;
			topModelTokens = tokens;
		}
	}

	return {
		todayCostUsd: perDay.get(toLocalDateKey(now))?.costUsd ?? 0,
		last30dCostUsd,
		last30dTokens,
		latestTokens,
		daily,
		topModel,
	};
}
