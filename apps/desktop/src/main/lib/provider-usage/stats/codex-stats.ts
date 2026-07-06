import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ProviderStats } from "../types";
import {
	addToDayAggregate,
	buildProviderStats,
	type DayAggregate,
	STATS_WINDOW_DAYS,
} from "./daily-aggregation";
import { estimateCostUsd, type TokenBreakdown } from "./pricing";

const STATS_MAX_AGE_MS = 15 * 60_000;

const tokenUsageSchema = z.object({
	input_tokens: z.number().optional().nullable(),
	cached_input_tokens: z.number().optional().nullable(),
	output_tokens: z.number().optional().nullable(),
	total_tokens: z.number().optional().nullable(),
});

export interface CodexSessionTotals {
	model: string;
	tokens: TokenBreakdown;
	totalTokens: number;
}

const MODEL_PATTERN = /"model"\s*:\s*"([^"]+)"/;

/**
 * Extracts the cumulative token totals (last `token_count` event) and model
 * from a Codex session JSONL file's lines.
 */
export function parseCodexSessionTotals(
	lines: string[],
): CodexSessionTotals | null {
	let usage: z.infer<typeof tokenUsageSchema> | null = null;
	let model = "gpt-5";

	for (const line of lines) {
		if (line.includes('"turn_context"')) {
			const match = MODEL_PATTERN.exec(line);
			if (match?.[1]) model = match[1];
		}
		if (!line.includes('"total_token_usage"')) continue;
		let json: unknown;
		try {
			json = JSON.parse(line);
		} catch {
			continue;
		}
		const totalUsage = (
			json as { payload?: { info?: { total_token_usage?: unknown } } }
		).payload?.info?.total_token_usage;
		const parsed = tokenUsageSchema.safeParse(totalUsage);
		if (parsed.success) usage = parsed.data;
	}

	if (!usage) return null;
	const cachedInput = usage.cached_input_tokens ?? 0;
	const rawInput = usage.input_tokens ?? 0;
	const tokens: TokenBreakdown = {
		inputTokens: Math.max(0, rawInput - cachedInput),
		outputTokens: usage.output_tokens ?? 0,
		cacheWrite5mTokens: 0,
		cacheWrite1hTokens: 0,
		cacheReadTokens: cachedInput,
	};
	return {
		model,
		tokens,
		totalTokens: usage.total_tokens ?? rawInput + (usage.output_tokens ?? 0),
	};
}

interface FileAggregate {
	mtimeMs: number;
	size: number;
	totals: CodexSessionTotals | null;
}

const fileCache = new Map<string, FileAggregate>();
let cachedStats: { computedAt: number; stats: ProviderStats | null } | null =
	null;

async function aggregateFile(
	filePath: string,
	mtimeMs: number,
	size: number,
): Promise<CodexSessionTotals | null> {
	const cached = fileCache.get(filePath);
	if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
		return cached.totals;
	}
	let content: string;
	try {
		content = await fs.readFile(filePath, "utf8");
	} catch {
		return null;
	}
	const totals = parseCodexSessionTotals(content.split("\n"));
	fileCache.set(filePath, { mtimeMs, size, totals });
	return totals;
}

function* recentDateKeys(now: number): Generator<string> {
	for (let daysAgo = 0; daysAgo <= STATS_WINDOW_DAYS; daysAgo++) {
		const date = new Date(now - daysAgo * 24 * 60 * 60 * 1000);
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		yield `${year}-${month}-${day}`;
	}
}

async function collectCodexStatsNow(
	now: number,
): Promise<ProviderStats | null> {
	const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
	const perDay = new Map<string, DayAggregate>();
	const modelTokens = new Map<string, number>();
	let newestFile: { mtimeMs: number; tokens: number } | null = null;
	let foundAny = false;

	// Sessions are date-sharded (YYYY/MM/DD), so we can address the last 30
	// days directly instead of walking the whole tree.
	for (const dateKey of recentDateKeys(now)) {
		const [year, month, day] = dateKey.split("-");
		const dayDir = path.join(sessionsDir, year ?? "", month ?? "", day ?? "");
		let entries: string[];
		try {
			entries = await fs.readdir(dayDir);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (!name.endsWith(".jsonl")) continue;
			const filePath = path.join(dayDir, name);
			let stat: { mtimeMs: number; size: number };
			try {
				stat = await fs.stat(filePath);
			} catch {
				continue;
			}
			const totals = await aggregateFile(filePath, stat.mtimeMs, stat.size);
			if (!totals) continue;
			foundAny = true;

			const costUsd = estimateCostUsd(totals.model, totals.tokens);
			addToDayAggregate(perDay, dateKey, costUsd, totals.totalTokens);
			modelTokens.set(
				totals.model,
				(modelTokens.get(totals.model) ?? 0) + totals.totalTokens,
			);
			if (!newestFile || stat.mtimeMs > newestFile.mtimeMs) {
				newestFile = { mtimeMs: stat.mtimeMs, tokens: totals.totalTokens };
			}
		}
	}

	if (!foundAny) return null;
	return buildProviderStats({
		perDay,
		latestTokens: newestFile?.tokens ?? 0,
		modelTokens,
		now,
	});
}

export async function collectCodexStats(
	now = Date.now(),
): Promise<ProviderStats | null> {
	if (cachedStats && now - cachedStats.computedAt <= STATS_MAX_AGE_MS) {
		return cachedStats.stats;
	}
	try {
		const stats = await collectCodexStatsNow(now);
		cachedStats = { computedAt: now, stats };
		return stats;
	} catch {
		return cachedStats?.stats ?? null;
	}
}
