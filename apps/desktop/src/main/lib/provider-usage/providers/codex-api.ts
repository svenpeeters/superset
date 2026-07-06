import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ProviderCredits, UsageWindow } from "../types";

const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const windowSchema = z
	.object({
		used_percent: z.number().optional().nullable(),
		limit_window_seconds: z.number().optional().nullable(),
		reset_at: z.number().optional().nullable(),
	})
	.optional()
	.nullable();

const rateLimitSchema = z
	.object({
		primary_window: windowSchema,
		secondary_window: windowSchema,
	})
	.optional()
	.nullable();

const whamUsageSchema = z.object({
	email: z.string().optional().nullable(),
	plan_type: z.string().optional().nullable(),
	rate_limit: rateLimitSchema,
	additional_rate_limits: z
		.array(
			z.object({
				limit_name: z.string().optional().nullable(),
				metered_feature: z.string().optional().nullable(),
				rate_limit: rateLimitSchema,
			}),
		)
		.optional()
		.nullable(),
	credits: z
		.object({
			has_credits: z.boolean().optional().nullable(),
			unlimited: z.boolean().optional().nullable(),
			balance: z.union([z.string(), z.number()]).optional().nullable(),
		})
		.optional()
		.nullable(),
	rate_limit_reset_credits: z
		.object({
			available_count: z.number().optional().nullable(),
		})
		.optional()
		.nullable(),
});

const authFileSchema = z.object({
	tokens: z
		.object({
			access_token: z.string().optional().nullable(),
			account_id: z.string().optional().nullable(),
		})
		.optional()
		.nullable(),
});

export interface CodexApiUsage {
	windows: UsageWindow[];
	email: string | null;
	plan: string | null;
	credits: ProviderCredits | null;
	manualResetsAvailable: number | null;
}

function windowLabelSuffix(
	limitWindowSeconds: number | null | undefined,
	fallback: string,
): string {
	if (
		typeof limitWindowSeconds !== "number" ||
		!Number.isFinite(limitWindowSeconds)
	) {
		return fallback;
	}
	const minutes = limitWindowSeconds / 60;
	if (minutes >= 10080) {
		const weeks = Math.round(minutes / 10080);
		return weeks <= 1 ? "Weekly" : `${weeks}-week window`;
	}
	if (minutes >= 60) return `${Math.round(minutes / 60)}-hour session`;
	return `${Math.round(minutes)}-minute window`;
}

/** "GPT-5.3-Codex-Spark" → "Codex Spark" */
function prettyLimitName(limitName: string): string {
	return limitName.replace(/^GPT-[\d.]+-/i, "").replace(/-/g, " ");
}

function mapWindow(
	bucket: z.infer<typeof windowSchema>,
	id: string,
	labelPrefix: string,
	fallbackLabel: string,
): UsageWindow | null {
	const usedPercent = bucket?.used_percent;
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
		return null;
	}
	const suffix = windowLabelSuffix(bucket?.limit_window_seconds, fallbackLabel);
	return {
		id,
		label: labelPrefix ? `${labelPrefix} ${suffix}` : suffix,
		usedPercent: Math.min(100, Math.max(0, usedPercent)),
		resetsAt:
			typeof bucket?.reset_at === "number" && Number.isFinite(bucket.reset_at)
				? bucket.reset_at * 1000
				: null,
		windowDurationMs:
			typeof bucket?.limit_window_seconds === "number" &&
			Number.isFinite(bucket.limit_window_seconds) &&
			bucket.limit_window_seconds > 0
				? bucket.limit_window_seconds * 1000
				: null,
	};
}

/** Maps a `wham/usage` response to usage windows and account extras. */
export function parseWhamUsage(json: unknown): CodexApiUsage | null {
	const parsed = whamUsageSchema.safeParse(json);
	if (!parsed.success) return null;
	const data = parsed.data;

	const windows: UsageWindow[] = [];
	const primary = mapWindow(
		data.rate_limit?.primary_window,
		"primary",
		"",
		"Session",
	);
	const secondary = mapWindow(
		data.rate_limit?.secondary_window,
		"secondary",
		"",
		"Weekly",
	);
	if (primary) windows.push(primary);
	if (secondary) windows.push(secondary);

	for (const extra of data.additional_rate_limits ?? []) {
		const name = extra.limit_name ? prettyLimitName(extra.limit_name) : "Extra";
		const slug =
			extra.metered_feature ?? name.toLowerCase().replace(/\s+/g, "-");
		const extraPrimary = mapWindow(
			extra.rate_limit?.primary_window,
			`${slug}-primary`,
			name,
			"Session",
		);
		const extraSecondary = mapWindow(
			extra.rate_limit?.secondary_window,
			`${slug}-secondary`,
			name,
			"Weekly",
		);
		if (extraPrimary) windows.push(extraPrimary);
		if (extraSecondary) windows.push(extraSecondary);
	}

	if (windows.length === 0) return null;

	const balanceRaw = data.credits?.balance;
	const balance =
		typeof balanceRaw === "string" ? Number.parseFloat(balanceRaw) : balanceRaw;

	return {
		windows,
		email: data.email ?? null,
		plan: data.plan_type ?? null,
		credits:
			typeof balance === "number" && Number.isFinite(balance)
				? { balance, currency: "credits" }
				: null,
		manualResetsAvailable:
			data.rate_limit_reset_credits?.available_count ?? null,
	};
}

/**
 * Fetches live usage from the Codex backend using the CLI's own OAuth token.
 * Returns null on any failure so the caller can fall back to local logs.
 */
export async function fetchCodexApiUsage(
	signal: AbortSignal,
): Promise<CodexApiUsage | null> {
	let accessToken: string | null = null;
	let accountId: string | null = null;
	try {
		const raw = await fs.readFile(
			path.join(os.homedir(), ".codex", "auth.json"),
			"utf8",
		);
		const parsed = authFileSchema.safeParse(JSON.parse(raw));
		if (parsed.success) {
			accessToken = parsed.data.tokens?.access_token ?? null;
			accountId = parsed.data.tokens?.account_id ?? null;
		}
	} catch {
		return null;
	}
	if (!accessToken) return null;

	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${accessToken}`,
		};
		if (accountId) headers["chatgpt-account-id"] = accountId;
		const response = await fetch(WHAM_USAGE_URL, { headers, signal });
		if (!response.ok) return null;
		const json: unknown = await response.json().catch(() => null);
		return parseWhamUsage(json);
	} catch {
		return null;
	}
}
