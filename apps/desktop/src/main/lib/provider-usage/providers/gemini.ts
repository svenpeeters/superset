import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
	ProviderAccount,
	ProviderUsage,
	UsageProvider,
	UsageWindow,
} from "../types";

const QUOTA_URL =
	"https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const LOAD_CODE_ASSIST_URL =
	"https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const TOKEN_REFRESH_URL = "https://oauth2.googleapis.com/token";

const DAY_MS = 24 * 60 * 60 * 1000;

const oauthCredsSchema = z.object({
	access_token: z.string().optional().nullable(),
	refresh_token: z.string().optional().nullable(),
	id_token: z.string().optional().nullable(),
	expiry_date: z.number().optional().nullable(),
});

const quotaResponseSchema = z.object({
	buckets: z
		.array(
			z.object({
				modelId: z.string().optional().nullable(),
				remainingFraction: z.number().optional().nullable(),
				resetTime: z.string().optional().nullable(),
			}),
		)
		.optional()
		.nullable(),
});

interface GeminiCredentials {
	accessToken: string | null;
	refreshToken: string | null;
	idToken: string | null;
	expiryDate: number | null;
}

function createUsage(
	partial: Pick<ProviderUsage, "status"> & Partial<ProviderUsage>,
): ProviderUsage {
	return {
		providerId: "gemini",
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

async function readGeminiCredentials(): Promise<GeminiCredentials | null> {
	try {
		const raw = await fs.readFile(
			path.join(os.homedir(), ".gemini", "oauth_creds.json"),
			"utf8",
		);
		const parsed = oauthCredsSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) return null;
		return {
			accessToken: parsed.data.access_token ?? null,
			refreshToken: parsed.data.refresh_token ?? null,
			idToken: parsed.data.id_token ?? null,
			expiryDate: parsed.data.expiry_date ?? null,
		};
	} catch {
		return null;
	}
}

/** Extracts the email claim from a JWT id_token without verifying it. */
export function parseIdTokenEmail(idToken: string | null): string | null {
	if (!idToken) return null;
	const payload = idToken.split(".")[1];
	if (!payload) return null;
	try {
		const json: unknown = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		);
		const email = (json as { email?: unknown }).email;
		return typeof email === "string" && email.length > 0 ? email : null;
	} catch {
		return null;
	}
}

interface OAuthClient {
	clientId: string;
	clientSecret: string;
}

/**
 * Extracts the CLI's installed-app OAuth client from a bundled source. The
 * values are public by design (Google's installed-app flow), but we resolve
 * them from the user's own CLI install instead of embedding them here.
 */
export function extractOAuthClient(source: string): OAuthClient | null {
	const clientId = source.match(
		/OAUTH_CLIENT_ID\s*=\s*["']([^"']+\.apps\.googleusercontent\.com)["']/,
	)?.[1];
	const clientSecret = source.match(
		/OAUTH_CLIENT_SECRET\s*=\s*["']([^"']+)["']/,
	)?.[1];
	return clientId && clientSecret ? { clientId, clientSecret } : null;
}

// Global package roots where @google/gemini-cli commonly lands.
function geminiPackageRoots(): string[] {
	const home = os.homedir();
	return [
		"/opt/homebrew/lib/node_modules",
		"/usr/local/lib/node_modules",
		path.join(home, ".npm-global", "lib", "node_modules"),
		path.join(home, ".bun", "install", "global", "node_modules"),
	];
}

async function scanFileForOAuthClient(
	filePath: string,
): Promise<OAuthClient | null> {
	try {
		const stat = await fs.stat(filePath);
		// The CLI bundle is large but bounded; skip anything implausible.
		if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return null;
		return extractOAuthClient(await fs.readFile(filePath, "utf8"));
	} catch {
		return null;
	}
}

async function scanPackageForOAuthClient(
	packageDir: string,
): Promise<OAuthClient | null> {
	// The constants live in the core bundle; check the usual dist layouts.
	const candidates = [
		path.join(packageDir, "dist", "index.js"),
		path.join(packageDir, "dist", "src", "code_assist", "oauth2.js"),
		path.join(packageDir, "bundle", "gemini.js"),
	];
	for (const candidate of candidates) {
		const client = await scanFileForOAuthClient(candidate);
		if (client) return client;
	}
	return null;
}

// The lookup hits the filesystem, so run it once and reuse the outcome.
let oauthClientLookup: Promise<OAuthClient | null> | null = null;

function resolveOAuthClient(): Promise<OAuthClient | null> {
	if (oauthClientLookup) return oauthClientLookup;
	oauthClientLookup = (async () => {
		const envId = process.env.GEMINI_OAUTH_CLIENT_ID;
		const envSecret = process.env.GEMINI_OAUTH_CLIENT_SECRET;
		if (envId && envSecret) {
			return { clientId: envId, clientSecret: envSecret };
		}
		for (const root of geminiPackageRoots()) {
			for (const pkg of ["@google/gemini-cli", "@google/gemini-cli-core"]) {
				const client = await scanPackageForOAuthClient(path.join(root, pkg));
				if (client) return client;
			}
		}
		return null;
	})();
	return oauthClientLookup;
}

const REFRESH_RETRY_COOLDOWN_MS = 5 * 60_000;

// Refreshed tokens stay in memory: writing them back would race the CLI.
let inMemoryToken: { accessToken: string; expiresAt: number } | null = null;
let lastRefreshAttemptAt = 0;

async function refreshAccessToken(
	refreshToken: string,
	signal: AbortSignal,
): Promise<string | null> {
	const now = Date.now();
	if (now - lastRefreshAttemptAt < REFRESH_RETRY_COOLDOWN_MS) return null;
	lastRefreshAttemptAt = now;
	const client = await resolveOAuthClient();
	if (!client) return null;
	try {
		const response = await fetch(TOKEN_REFRESH_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: client.clientId,
				client_secret: client.clientSecret,
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
	credentials: GeminiCredentials,
	signal: AbortSignal,
): Promise<string | null> {
	if (inMemoryToken && inMemoryToken.expiresAt > Date.now() + 60_000) {
		return inMemoryToken.accessToken;
	}
	const fileTokenValid =
		credentials.accessToken &&
		(typeof credentials.expiryDate !== "number" ||
			credentials.expiryDate > Date.now() + 60_000);
	if (fileTokenValid) return credentials.accessToken;
	if (credentials.refreshToken) {
		return refreshAccessToken(credentials.refreshToken, signal);
	}
	return null;
}

interface CodeAssistStatus {
	projectId: string | null;
	tier: string | null;
}

/** Mirrors the CLI's setupUser call: yields the managed project id and tier. */
async function loadCodeAssistStatus(
	accessToken: string,
	signal: AbortSignal,
): Promise<CodeAssistStatus> {
	try {
		const response = await fetch(LOAD_CODE_ASSIST_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" },
			}),
			signal,
		});
		if (!response.ok) return { projectId: null, tier: null };
		const json = (await response.json().catch(() => null)) as {
			cloudaicompanionProject?: unknown;
			currentTier?: { id?: unknown };
		} | null;
		const rawProject = json?.cloudaicompanionProject;
		const projectId =
			typeof rawProject === "string"
				? rawProject
				: typeof (rawProject as { id?: unknown })?.id === "string"
					? ((rawProject as { id: string }).id ?? null)
					: null;
		const tier =
			typeof json?.currentTier?.id === "string" ? json.currentTier.id : null;
		return { projectId: projectId?.trim() || null, tier };
	} catch {
		return { projectId: null, tier: null };
	}
}

/** "standard-tier" → "Standard tier" */
function formatTierLabel(tier: string | null): string | null {
	if (!tier) return null;
	const words = tier.replace(/-/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Maps a retrieveUserQuota response to one daily window per model, keeping
 * the most-used bucket when a model reports several.
 */
export function mapGeminiQuotaWindows(json: unknown): UsageWindow[] | null {
	const parsed = quotaResponseSchema.safeParse(json);
	if (!parsed.success || !parsed.data.buckets) return null;

	const byModel = new Map<
		string,
		{ fraction: number; resetTime: string | null }
	>();
	for (const bucket of parsed.data.buckets) {
		const modelId = bucket.modelId;
		const fraction = bucket.remainingFraction;
		if (
			!modelId ||
			typeof fraction !== "number" ||
			!Number.isFinite(fraction)
		) {
			continue;
		}
		const existing = byModel.get(modelId);
		if (!existing || fraction < existing.fraction) {
			byModel.set(modelId, { fraction, resetTime: bucket.resetTime ?? null });
		}
	}
	if (byModel.size === 0) return null;

	return [...byModel.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([modelId, quota]) => {
			const resetsAtMs = quota.resetTime
				? Date.parse(quota.resetTime)
				: Number.NaN;
			return {
				id: `daily_${modelId}`,
				label: `Daily (${modelId})`,
				usedPercent: Math.min(100, Math.max(0, (1 - quota.fraction) * 100)),
				resetsAt: Number.isFinite(resetsAtMs) ? resetsAtMs : null,
				windowDurationMs: DAY_MS,
			};
		});
}

export const geminiUsageProvider: UsageProvider = {
	id: "gemini",
	async fetchUsage(signal) {
		const credentials = await readGeminiCredentials();
		if (!credentials) {
			return createUsage({ status: "no-credentials" });
		}

		const accessToken = await resolveAccessToken(credentials, signal);
		if (!accessToken) {
			return createUsage({ status: "auth-expired" });
		}

		const status = await loadCodeAssistStatus(accessToken, signal);

		let response: Response;
		try {
			response = await fetch(QUOTA_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(
					status.projectId ? { project: status.projectId } : {},
				),
				signal,
			});
		} catch (error) {
			return createUsage({
				status: "error",
				errorMessage:
					error instanceof Error ? error.message : "Network request failed",
			});
		}

		if (response.status === 401 || response.status === 403) {
			return createUsage({ status: "auth-expired" });
		}
		if (!response.ok) {
			return createUsage({
				status: "error",
				errorMessage: `Gemini quota endpoint returned ${response.status}`,
			});
		}

		const json: unknown = await response.json().catch(() => null);
		const windows = mapGeminiQuotaWindows(json);
		if (!windows) {
			return createUsage({
				status: "error",
				errorMessage: "No quota buckets in the Gemini response",
			});
		}

		const account: ProviderAccount = {
			email: parseIdTokenEmail(credentials.idToken),
			plan: formatTierLabel(status.tier),
		};
		return createUsage({ status: "ok", windows, account });
	},
};
