import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ProviderStats } from "../types";
import {
	addToDayAggregate,
	buildProviderStats,
	type DayAggregate,
	mergeDayAggregates,
	STATS_WINDOW_DAYS,
	toLocalDateKey,
} from "./daily-aggregation";
import { estimateCostUsd, type TokenBreakdown, totalTokens } from "./pricing";

const STATS_MAX_AGE_MS = 15 * 60_000;
const SCAN_WINDOW_MS = (STATS_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000;

const usageEntrySchema = z.object({
	timestamp: z.string(),
	uuid: z.string().optional().nullable(),
	message: z.object({
		id: z.string().optional().nullable(),
		model: z.string().optional().nullable(),
		usage: z.object({
			input_tokens: z.number().optional().nullable(),
			output_tokens: z.number().optional().nullable(),
			cache_creation_input_tokens: z.number().optional().nullable(),
			cache_read_input_tokens: z.number().optional().nullable(),
			cache_creation: z
				.object({
					ephemeral_5m_input_tokens: z.number().optional().nullable(),
					ephemeral_1h_input_tokens: z.number().optional().nullable(),
				})
				.optional()
				.nullable(),
		}),
	}),
});

export interface ParsedUsageEntry {
	timestampMs: number;
	model: string;
	tokens: TokenBreakdown;
	dedupeKey: string;
}

/** Parses one Claude Code project-log JSONL entry carrying token usage. */
export function parseClaudeUsageEntry(json: unknown): ParsedUsageEntry | null {
	const parsed = usageEntrySchema.safeParse(json);
	if (!parsed.success) return null;

	const { timestamp, uuid, message } = parsed.data;
	const timestampMs = Date.parse(timestamp);
	if (!Number.isFinite(timestampMs)) return null;

	const usage = message.usage;
	const cacheWriteTotal = usage.cache_creation_input_tokens ?? 0;
	const cacheWrite5m =
		usage.cache_creation?.ephemeral_5m_input_tokens ?? cacheWriteTotal;
	const cacheWrite1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;

	return {
		timestampMs,
		model: message.model ?? "unknown",
		tokens: {
			inputTokens: usage.input_tokens ?? 0,
			outputTokens: usage.output_tokens ?? 0,
			cacheWrite5mTokens: cacheWrite5m,
			cacheWrite1hTokens: cacheWrite1h,
			cacheReadTokens: usage.cache_read_input_tokens ?? 0,
		},
		dedupeKey: message.id ?? uuid ?? `${timestamp}:${usage.output_tokens}`,
	};
}

interface FileAggregate {
	mtimeMs: number;
	size: number;
	perDay: Map<string, DayAggregate>;
	modelTokens: Map<string, number>;
	totalTokens: number;
}

const fileCache = new Map<string, FileAggregate>();
let cachedStats: { computedAt: number; stats: ProviderStats | null } | null =
	null;

function aggregateFileContent(
	content: string,
	mtimeMs: number,
	size: number,
): FileAggregate {
	const perDay = new Map<string, DayAggregate>();
	const modelTokens = new Map<string, number>();
	const seen = new Set<string>();
	let total = 0;

	for (const line of content.split("\n")) {
		if (!line.includes('"usage"')) continue;
		let json: unknown;
		try {
			json = JSON.parse(line);
		} catch {
			continue;
		}
		const entry = parseClaudeUsageEntry(json);
		if (!entry || seen.has(entry.dedupeKey)) continue;
		seen.add(entry.dedupeKey);
		if (entry.model === "<synthetic>") continue;

		const tokens = totalTokens(entry.tokens);
		const costUsd = estimateCostUsd(entry.model, entry.tokens);
		addToDayAggregate(
			perDay,
			toLocalDateKey(entry.timestampMs),
			costUsd,
			tokens,
		);
		modelTokens.set(entry.model, (modelTokens.get(entry.model) ?? 0) + tokens);
		total += tokens;
	}

	return { mtimeMs, size, perDay, modelTokens, totalTokens: total };
}

async function aggregateFile(
	filePath: string,
	mtimeMs: number,
	size: number,
): Promise<FileAggregate | null> {
	const cached = fileCache.get(filePath);
	if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
		return cached;
	}
	let content: string;
	try {
		content = await fs.readFile(filePath, "utf8");
	} catch {
		return null;
	}
	const aggregate = aggregateFileContent(content, mtimeMs, size);
	fileCache.set(filePath, aggregate);
	return aggregate;
}

async function collectClaudeStatsNow(
	now: number,
): Promise<ProviderStats | null> {
	const projectsDir = path.join(os.homedir(), ".claude", "projects");
	let projectDirs: string[];
	try {
		projectDirs = await fs.readdir(projectsDir);
	} catch {
		return null;
	}

	const cutoff = now - SCAN_WINDOW_MS;
	const perDay = new Map<string, DayAggregate>();
	const modelTokens = new Map<string, number>();
	let newestFile: { mtimeMs: number; tokens: number } | null = null;

	for (const projectDir of projectDirs) {
		const dirPath = path.join(projectsDir, projectDir);
		let entries: string[];
		try {
			entries = await fs.readdir(dirPath);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (!name.endsWith(".jsonl")) continue;
			const filePath = path.join(dirPath, name);
			let stat: { mtimeMs: number; size: number };
			try {
				stat = await fs.stat(filePath);
			} catch {
				continue;
			}
			if (stat.mtimeMs < cutoff) continue;

			const aggregate = await aggregateFile(filePath, stat.mtimeMs, stat.size);
			if (!aggregate) continue;
			mergeDayAggregates(perDay, aggregate.perDay);
			for (const [model, tokens] of aggregate.modelTokens) {
				modelTokens.set(model, (modelTokens.get(model) ?? 0) + tokens);
			}
			if (
				aggregate.totalTokens > 0 &&
				(!newestFile || stat.mtimeMs > newestFile.mtimeMs)
			) {
				newestFile = { mtimeMs: stat.mtimeMs, tokens: aggregate.totalTokens };
			}
		}
	}

	if (perDay.size === 0) return null;
	return buildProviderStats({
		perDay,
		latestTokens: newestFile?.tokens ?? 0,
		modelTokens,
		now,
	});
}

export async function collectClaudeStats(
	now = Date.now(),
): Promise<ProviderStats | null> {
	if (cachedStats && now - cachedStats.computedAt <= STATS_MAX_AGE_MS) {
		return cachedStats.stats;
	}
	try {
		const stats = await collectClaudeStatsNow(now);
		cachedStats = { computedAt: now, stats };
		return stats;
	} catch {
		return cachedStats?.stats ?? null;
	}
}
