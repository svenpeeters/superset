import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { collectCodexStats } from "../stats/codex-stats";
import type {
	ProviderAccount,
	ProviderUsage,
	UsageProvider,
	UsageWindow,
} from "../types";
import { fetchCodexApiUsage } from "./codex-api";

const TAIL_BYTES = 64 * 1024;
const MAX_FILES_TO_SCAN = 3;

const rateLimitWindowSchema = z
	.object({
		used_percent: z.number().optional().nullable(),
		window_minutes: z.number().optional().nullable(),
		resets_in_seconds: z.number().optional().nullable(),
		resets_at: z.number().optional().nullable(),
	})
	.optional()
	.nullable();

const rateLimitsSchema = z.object({
	primary: rateLimitWindowSchema,
	secondary: rateLimitWindowSchema,
	plan_type: z.string().optional().nullable(),
});

const authTokensSchema = z.object({
	tokens: z
		.object({
			id_token: z.string().optional().nullable(),
		})
		.optional()
		.nullable(),
});

const idTokenClaimsSchema = z.object({
	email: z.string().optional().nullable(),
	"https://api.openai.com/auth": z
		.object({
			chatgpt_plan_type: z.string().optional().nullable(),
		})
		.optional()
		.nullable(),
});

interface ParsedRateLimits {
	windows: UsageWindow[];
	plan: string | null;
	dataAsOf: number | null;
}

function createUsage(
	partial: Pick<ProviderUsage, "status"> & Partial<ProviderUsage>,
): ProviderUsage {
	return {
		providerId: "codex",
		windows: [],
		account: null,
		credits: null,
		manualResetsAvailable: null,
		costUsd: null,
		stats: null,
		fetchedAt: Date.now(),
		dataAsOf: null,
		errorMessage: null,
		...partial,
	};
}

const PLAN_LABELS: Record<string, string> = {
	prolite: "Pro Lite",
	pro: "Pro",
	plus: "Plus",
	team: "Team",
	business: "Business",
	enterprise: "Enterprise",
};

function formatPlanLabel(plan: string | null | undefined): string | null {
	if (!plan) return null;
	const known = PLAN_LABELS[plan.toLowerCase()];
	if (known) return known;
	return plan
		.split(/[_-]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function formatWindowLabel(
	windowMinutes: number | null | undefined,
	fallback: string,
): string {
	if (typeof windowMinutes !== "number" || !Number.isFinite(windowMinutes)) {
		return fallback;
	}
	if (windowMinutes >= 10080) {
		const weeks = Math.round(windowMinutes / 10080);
		return weeks <= 1 ? "Weekly" : `${weeks}-week window`;
	}
	if (windowMinutes >= 60) {
		return `${Math.round(windowMinutes / 60)}-hour session`;
	}
	return `${Math.round(windowMinutes)}-minute window`;
}

function toResetsAtMs(
	bucket: NonNullable<z.infer<typeof rateLimitWindowSchema>>,
	eventTimeMs: number,
): number | null {
	if (
		typeof bucket.resets_at === "number" &&
		Number.isFinite(bucket.resets_at)
	) {
		// Epoch seconds in current Codex versions; tolerate ms just in case.
		return bucket.resets_at > 1e12 ? bucket.resets_at : bucket.resets_at * 1000;
	}
	if (
		typeof bucket.resets_in_seconds === "number" &&
		Number.isFinite(bucket.resets_in_seconds)
	) {
		return eventTimeMs + bucket.resets_in_seconds * 1000;
	}
	return null;
}

function findRateLimits(value: unknown): unknown {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (record.rate_limits) return record.rate_limits;
	const payload = record.payload;
	if (payload && typeof payload === "object") {
		const payloadRecord = payload as Record<string, unknown>;
		if (payloadRecord.rate_limits) return payloadRecord.rate_limits;
	}
	return null;
}

function findTimestamp(value: unknown): number | null {
	if (!value || typeof value !== "object") return null;
	const timestamp = (value as Record<string, unknown>).timestamp;
	if (typeof timestamp !== "string") return null;
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Scans JSONL lines (newest last) for the most recent Codex `token_count`
 * event carrying `rate_limits` and maps it to usage windows.
 */
export function parseCodexRateLimits(lines: string[]): ParsedRateLimits | null {
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim();
		if (!line || !line.includes("rate_limits")) continue;

		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}

		const rateLimits = rateLimitsSchema.safeParse(findRateLimits(event));
		if (!rateLimits.success) continue;

		const dataAsOf = findTimestamp(event);
		const eventTimeMs = dataAsOf ?? Date.now();
		const windows: UsageWindow[] = [];

		const buckets = [
			{
				id: "primary",
				fallbackLabel: "Session",
				data: rateLimits.data.primary,
			},
			{
				id: "secondary",
				fallbackLabel: "Weekly",
				data: rateLimits.data.secondary,
			},
		];
		for (const bucket of buckets) {
			const usedPercent = bucket.data?.used_percent;
			if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
				continue;
			}
			const windowMinutes = bucket.data?.window_minutes;
			windows.push({
				id: bucket.id,
				label: formatWindowLabel(windowMinutes, bucket.fallbackLabel),
				usedPercent: Math.min(100, Math.max(0, usedPercent)),
				resetsAt: bucket.data ? toResetsAtMs(bucket.data, eventTimeMs) : null,
				windowDurationMs:
					typeof windowMinutes === "number" && Number.isFinite(windowMinutes)
						? windowMinutes * 60_000
						: null,
			});
		}

		if (windows.length > 0) {
			return {
				windows,
				plan: formatPlanLabel(rateLimits.data.plan_type),
				dataAsOf,
			};
		}
	}
	return null;
}

/** Reads account email/plan from the id_token claims in ~/.codex/auth.json. */
export function parseCodexAccount(raw: string): ProviderAccount | null {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	const parsed = authTokensSchema.safeParse(json);
	const idToken = parsed.success ? parsed.data.tokens?.id_token : null;
	if (!idToken) return null;

	const payloadSegment = idToken.split(".")[1];
	if (!payloadSegment) return null;
	let claims: unknown;
	try {
		claims = JSON.parse(Buffer.from(payloadSegment, "base64url").toString());
	} catch {
		return null;
	}
	const parsedClaims = idTokenClaimsSchema.safeParse(claims);
	if (!parsedClaims.success) return null;
	return {
		email: parsedClaims.data.email ?? null,
		plan: formatPlanLabel(
			parsedClaims.data["https://api.openai.com/auth"]?.chatgpt_plan_type,
		),
	};
}

async function listSortedDirs(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort()
			.reverse();
	} catch {
		return [];
	}
}

/**
 * Yields session JSONL paths newest-first without scanning the whole tree.
 * Sessions are sharded as `YYYY/MM/DD/*.jsonl`.
 */
async function findRecentSessionFiles(
	sessionsDir: string,
	limit: number,
): Promise<string[]> {
	const found: string[] = [];
	for (const year of await listSortedDirs(sessionsDir)) {
		for (const month of await listSortedDirs(path.join(sessionsDir, year))) {
			for (const day of await listSortedDirs(
				path.join(sessionsDir, year, month),
			)) {
				const dayDir = path.join(sessionsDir, year, month, day);
				let entries: string[];
				try {
					entries = await fs.readdir(dayDir);
				} catch {
					continue;
				}
				const files = entries.filter((name) => name.endsWith(".jsonl"));
				const withMtime = await Promise.all(
					files.map(async (name) => {
						const filePath = path.join(dayDir, name);
						try {
							const stat = await fs.stat(filePath);
							return { filePath, mtimeMs: stat.mtimeMs };
						} catch {
							return null;
						}
					}),
				);
				const sorted = withMtime
					.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
					.sort((a, b) => b.mtimeMs - a.mtimeMs);
				for (const entry of sorted) {
					found.push(entry.filePath);
					if (found.length >= limit) return found;
				}
			}
		}
	}
	return found;
}

async function readFileTail(filePath: string): Promise<string[]> {
	const handle = await fs.open(filePath, "r");
	try {
		const { size } = await handle.stat();
		const start = Math.max(0, size - TAIL_BYTES);
		const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
		await handle.read(buffer, 0, buffer.length, start);
		const lines = buffer.toString("utf8").split("\n");
		// Drop the first line when reading mid-file: it is likely truncated.
		return start > 0 ? lines.slice(1) : lines;
	} finally {
		await handle.close();
	}
}

async function readFileOrNull(target: string): Promise<string | null> {
	try {
		return await fs.readFile(target, "utf8");
	} catch {
		return null;
	}
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

export const codexUsageProvider: UsageProvider = {
	id: "codex",
	async fetchUsage(signal) {
		const codexDir = path.join(os.homedir(), ".codex");
		const sessionsDir = path.join(codexDir, "sessions");
		const authRaw = await readFileOrNull(path.join(codexDir, "auth.json"));
		if (!authRaw && !(await pathExists(sessionsDir))) {
			return createUsage({ status: "no-credentials" });
		}

		const account = authRaw ? parseCodexAccount(authRaw) : null;
		const stats = await collectCodexStats();

		// Live account-wide data from the Codex backend; falls back to local
		// session logs (this machine only, possibly stale) when unavailable.
		const apiUsage = await fetchCodexApiUsage(signal);
		if (apiUsage) {
			return createUsage({
				status: "ok",
				windows: apiUsage.windows,
				account: {
					email: apiUsage.email ?? account?.email ?? null,
					plan: formatPlanLabel(apiUsage.plan) ?? account?.plan ?? null,
				},
				credits: apiUsage.credits,
				manualResetsAvailable: apiUsage.manualResetsAvailable,
				stats,
			});
		}

		const files = await findRecentSessionFiles(sessionsDir, MAX_FILES_TO_SCAN);
		for (const filePath of files) {
			let lines: string[];
			try {
				lines = await readFileTail(filePath);
			} catch {
				continue;
			}
			const parsed = parseCodexRateLimits(lines);
			if (parsed) {
				return createUsage({
					status: "ok",
					windows: parsed.windows,
					account: {
						email: account?.email ?? null,
						plan: parsed.plan ?? account?.plan ?? null,
					},
					stats,
					dataAsOf: parsed.dataAsOf,
				});
			}
		}

		return createUsage({
			status: "error",
			account,
			stats,
			errorMessage: "No recent rate-limit data in Codex session logs",
		});
	},
};
