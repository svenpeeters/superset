import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { collectClaudeStats } from "../stats/claude-stats";
import type {
	ProviderAccount,
	ProviderUsage,
	UsageProvider,
	UsageWindow,
} from "../types";

const execFileAsync = promisify(execFile);

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const KEYCHAIN_SERVICE = "Claude Code-credentials";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const claudeCredentialsSchema = z.object({
	claudeAiOauth: z
		.object({
			accessToken: z.string().min(1),
			refreshToken: z.string().optional().nullable(),
			expiresAt: z.number().optional().nullable(),
			subscriptionType: z.string().optional().nullable(),
		})
		.optional()
		.nullable(),
});

const claudeConfigSchema = z.object({
	oauthAccount: z
		.object({
			emailAddress: z.string().optional().nullable(),
		})
		.optional()
		.nullable(),
});

const usageBucketSchema = z.object({
	utilization: z.number(),
	resets_at: z.string().optional().nullable(),
});

interface KnownWindow {
	label: string;
	durationMs: number | null;
}

const KNOWN_WINDOWS: Record<string, KnownWindow> = {
	five_hour: { label: "5-hour session", durationMs: 5 * HOUR_MS },
	seven_day: { label: "Weekly (all models)", durationMs: 7 * DAY_MS },
	seven_day_opus: { label: "Weekly (Opus)", durationMs: 7 * DAY_MS },
	seven_day_sonnet: { label: "Weekly (Sonnet)", durationMs: 7 * DAY_MS },
	seven_day_oauth_apps: { label: "Weekly (apps)", durationMs: 7 * DAY_MS },
};

interface ClaudeCredentials {
	accessToken: string;
	refreshToken: string | null;
	expiresAt: number | null;
	plan: string | null;
}

function createUsage(
	partial: Pick<ProviderUsage, "status"> & Partial<ProviderUsage>,
): ProviderUsage {
	return {
		providerId: "claude",
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

function formatPlanLabel(plan: string | null | undefined): string | null {
	if (!plan) return null;
	return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function humanizeBucketKey(key: string): string {
	return key
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function parseCredentialsJson(raw: string): ClaudeCredentials | null {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	const parsed = claudeCredentialsSchema.safeParse(json);
	if (!parsed.success || !parsed.data.claudeAiOauth) return null;
	return {
		accessToken: parsed.data.claudeAiOauth.accessToken,
		refreshToken: parsed.data.claudeAiOauth.refreshToken ?? null,
		expiresAt: parsed.data.claudeAiOauth.expiresAt ?? null,
		plan: formatPlanLabel(parsed.data.claudeAiOauth.subscriptionType),
	};
}

// The macOS Keychain lookup can trigger a user-facing prompt, so attempt it
// at most once per app session and reuse the outcome (including failure).
let keychainLookup: Promise<ClaudeCredentials | null> | null = null;

function readKeychainCredentials(): Promise<ClaudeCredentials | null> {
	if (os.platform() !== "darwin") return Promise.resolve(null);
	if (!keychainLookup) {
		keychainLookup = execFileAsync(
			"security",
			["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
			{ timeout: 3000 },
		)
			.then(({ stdout }) => parseCredentialsJson(stdout.trim()))
			.catch(() => null);
	}
	return keychainLookup;
}

async function readClaudeCredentials(): Promise<ClaudeCredentials | null> {
	const credentialsPath = path.join(
		os.homedir(),
		".claude",
		".credentials.json",
	);
	try {
		const raw = await fs.readFile(credentialsPath, "utf8");
		const credentials = parseCredentialsJson(raw);
		if (credentials) return credentials;
	} catch {
		// File missing or unreadable — fall through to the keychain.
	}
	return readKeychainCredentials();
}

async function readClaudeEmail(): Promise<string | null> {
	try {
		const raw = await fs.readFile(
			path.join(os.homedir(), ".claude.json"),
			"utf8",
		);
		const parsed = claudeConfigSchema.safeParse(JSON.parse(raw));
		return parsed.success
			? (parsed.data.oauthAccount?.emailAddress ?? null)
			: null;
	} catch {
		return null;
	}
}

/** Maps the OAuth usage response's rate-limit buckets to usage windows. */
export function mapClaudeUsageWindows(json: unknown): UsageWindow[] | null {
	if (!json || typeof json !== "object") return null;

	const windows: UsageWindow[] = [];
	for (const [key, value] of Object.entries(json)) {
		const bucket = usageBucketSchema.safeParse(value);
		if (!bucket.success || !Number.isFinite(bucket.data.utilization)) {
			continue;
		}
		const known = KNOWN_WINDOWS[key];
		const resetsAtMs = bucket.data.resets_at
			? Date.parse(bucket.data.resets_at)
			: Number.NaN;
		windows.push({
			id: key,
			label: known?.label ?? humanizeBucketKey(key),
			usedPercent: Math.min(100, Math.max(0, bucket.data.utilization)),
			resetsAt: Number.isFinite(resetsAtMs) ? resetsAtMs : null,
			windowDurationMs: known?.durationMs ?? null,
		});
	}
	return windows.length > 0 ? windows : null;
}

const CLAUDE_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
// Claude Code's public OAuth client id.
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REFRESH_RETRY_COOLDOWN_MS = 5 * 60_000;

// Refreshed tokens are kept in memory only: writing them back to the
// credentials file would race the Claude CLI's own refresh logic.
let inMemoryToken: { accessToken: string; expiresAt: number } | null = null;
let lastRefreshAttemptAt = 0;

async function refreshAccessToken(
	refreshToken: string,
	signal: AbortSignal,
): Promise<string | null> {
	const now = Date.now();
	if (now - lastRefreshAttemptAt < REFRESH_RETRY_COOLDOWN_MS) return null;
	lastRefreshAttemptAt = now;
	try {
		const response = await fetch(CLAUDE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLAUDE_OAUTH_CLIENT_ID,
			}),
			signal,
		});
		if (!response.ok) return null;
		const json = (await response.json()) as {
			access_token?: string;
			expires_in?: number;
		};
		if (!json.access_token) return null;
		inMemoryToken = {
			accessToken: json.access_token,
			expiresAt: now + (json.expires_in ?? 3600) * 1000,
		};
		return inMemoryToken.accessToken;
	} catch {
		return null;
	}
}

async function resolveAccessToken(
	credentials: ClaudeCredentials,
	signal: AbortSignal,
): Promise<string | null> {
	if (inMemoryToken && inMemoryToken.expiresAt > Date.now() + 60_000) {
		return inMemoryToken.accessToken;
	}
	const fileTokenValid =
		typeof credentials.expiresAt !== "number" ||
		credentials.expiresAt > Date.now();
	if (fileTokenValid) return credentials.accessToken;
	if (credentials.refreshToken) {
		return refreshAccessToken(credentials.refreshToken, signal);
	}
	return null;
}

// Anthropic rate-limits this unofficial endpoint aggressively. After a 429,
// stop calling it until the cooldown passes and serve the last good windows
// (with dataAsOf set) so the card shows slightly stale data, not an error.
const RATE_LIMIT_DEFAULT_COOLDOWN_MS = 5 * 60_000;
const RATE_LIMIT_MAX_COOLDOWN_MS = 30 * 60_000;

let rateLimitedUntil = 0;
let lastGoodWindows: { windows: UsageWindow[]; fetchedAt: number } | null =
	null;

/** Cooldown after a 429, honoring a numeric Retry-After header if present. */
export function rateLimitCooldownMs(retryAfterHeader: string | null): number {
	const retryAfterSec = Number(retryAfterHeader);
	if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
		return Math.min(retryAfterSec * 1000, RATE_LIMIT_MAX_COOLDOWN_MS);
	}
	return RATE_LIMIT_DEFAULT_COOLDOWN_MS;
}

type UsageWindowsResult = Pick<
	ProviderUsage,
	"status" | "windows" | "errorMessage"
> &
	Partial<Pick<ProviderUsage, "dataAsOf">>;

function rateLimitedResult(): UsageWindowsResult {
	if (lastGoodWindows) {
		return {
			status: "ok",
			windows: lastGoodWindows.windows,
			errorMessage: null,
			dataAsOf: lastGoodWindows.fetchedAt,
		};
	}
	return {
		status: "error",
		windows: [],
		errorMessage: "Rate limited by Anthropic — retrying automatically.",
	};
}

async function fetchUsageWindows(
	credentials: ClaudeCredentials,
	signal: AbortSignal,
): Promise<UsageWindowsResult> {
	if (Date.now() < rateLimitedUntil) {
		return rateLimitedResult();
	}

	const accessToken = await resolveAccessToken(credentials, signal);
	if (!accessToken) {
		return { status: "auth-expired", windows: [], errorMessage: null };
	}

	let response: Response;
	try {
		response = await fetch(CLAUDE_USAGE_URL, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"anthropic-beta": CLAUDE_OAUTH_BETA,
			},
			signal,
		});
	} catch (error) {
		return {
			status: "error",
			windows: [],
			errorMessage:
				error instanceof Error ? error.message : "Network request failed",
		};
	}

	if (response.status === 401 || response.status === 403) {
		// The stored token was rejected — try one refresh, then retry once.
		const refreshed = credentials.refreshToken
			? await refreshAccessToken(credentials.refreshToken, signal)
			: null;
		if (refreshed) {
			try {
				response = await fetch(CLAUDE_USAGE_URL, {
					headers: {
						Authorization: `Bearer ${refreshed}`,
						"anthropic-beta": CLAUDE_OAUTH_BETA,
					},
					signal,
				});
			} catch {
				return { status: "auth-expired", windows: [], errorMessage: null };
			}
		}
		if (response.status === 401 || response.status === 403) {
			return { status: "auth-expired", windows: [], errorMessage: null };
		}
	}
	if (response.status === 429) {
		rateLimitedUntil =
			Date.now() + rateLimitCooldownMs(response.headers.get("retry-after"));
		return rateLimitedResult();
	}
	if (!response.ok) {
		return {
			status: "error",
			windows: [],
			errorMessage: `Anthropic usage endpoint returned ${response.status}`,
		};
	}

	const json: unknown = await response.json().catch(() => null);
	const windows = mapClaudeUsageWindows(json);
	if (!windows) {
		return {
			status: "error",
			windows: [],
			errorMessage: "Unrecognized usage response from Anthropic",
		};
	}
	lastGoodWindows = { windows, fetchedAt: Date.now() };
	rateLimitedUntil = 0;
	return { status: "ok", windows, errorMessage: null };
}

export const claudeUsageProvider: UsageProvider = {
	id: "claude",
	async fetchUsage(signal) {
		const credentials = await readClaudeCredentials();
		if (!credentials) {
			return createUsage({ status: "no-credentials" });
		}

		// Account info and local-log stats are useful even when the usage
		// endpoint fails, so gather them regardless of the fetch outcome.
		const [email, stats, windowsResult] = await Promise.all([
			readClaudeEmail(),
			collectClaudeStats(),
			fetchUsageWindows(credentials, signal),
		]);

		const account: ProviderAccount = { email, plan: credentials.plan };
		return createUsage({ ...windowsResult, account, stats });
	},
};
