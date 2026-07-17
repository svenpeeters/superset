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

const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";

const quotaSnapshotSchema = z
	.object({
		entitlement: z.number().optional().nullable(),
		remaining: z.number().optional().nullable(),
		percent_remaining: z.number().optional().nullable(),
		unlimited: z.boolean().optional().nullable(),
	})
	.optional()
	.nullable();

const copilotUsageSchema = z.object({
	copilot_plan: z.string().optional().nullable(),
	quota_reset_date: z.string().optional().nullable(),
	quota_snapshots: z
		.object({
			premium_interactions: quotaSnapshotSchema,
			chat: quotaSnapshotSchema,
		})
		.optional()
		.nullable(),
});

// Copilot's editor integrations store a GitHub OAuth token per host.
const hostsFileSchema = z.record(
	z.string(),
	z
		.object({
			oauth_token: z.string().optional().nullable(),
			user: z.string().optional().nullable(),
		})
		.optional()
		.nullable(),
);

interface CopilotToken {
	token: string;
	user: string | null;
}

function createUsage(
	partial: Pick<ProviderUsage, "status"> & Partial<ProviderUsage>,
): ProviderUsage {
	return {
		providerId: "copilot",
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

function parseTokenFile(raw: string): CopilotToken | null {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	const parsed = hostsFileSchema.safeParse(json);
	if (!parsed.success) return null;
	// Keys are "github.com" in hosts.json and "github.com:<app-id>" in
	// apps.json; any github.com entry carries a usable OAuth token.
	for (const [host, entry] of Object.entries(parsed.data)) {
		if (!host.startsWith("github.com")) continue;
		if (entry?.oauth_token) {
			return { token: entry.oauth_token, user: entry.user ?? null };
		}
	}
	return null;
}

async function readCopilotToken(): Promise<CopilotToken | null> {
	const configDir = path.join(os.homedir(), ".config", "github-copilot");
	for (const file of ["hosts.json", "apps.json"]) {
		try {
			const raw = await fs.readFile(path.join(configDir, file), "utf8");
			const token = parseTokenFile(raw);
			if (token) return token;
		} catch {
			// File missing — try the next candidate.
		}
	}
	return null;
}

function formatPlanLabel(plan: string | null | undefined): string | null {
	if (!plan || plan === "unknown") return null;
	return plan
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function mapQuotaWindow(
	snapshot: z.infer<typeof quotaSnapshotSchema>,
	id: string,
	label: string,
	resetsAt: number | null,
): UsageWindow | null {
	if (!snapshot || snapshot.unlimited) return null;
	let percentRemaining = snapshot.percent_remaining;
	if (typeof percentRemaining !== "number") {
		// Derive from counts when the API omits the percentage.
		if (
			typeof snapshot.entitlement !== "number" ||
			typeof snapshot.remaining !== "number" ||
			snapshot.entitlement <= 0
		) {
			return null;
		}
		percentRemaining = (snapshot.remaining / snapshot.entitlement) * 100;
	}
	if (!Number.isFinite(percentRemaining)) return null;
	// GitHub returns zeroed snapshots for token-based billing seats; showing
	// them would render fake 0%-or-100% usage.
	if (
		snapshot.entitlement === 0 &&
		snapshot.remaining === 0 &&
		snapshot.percent_remaining == null
	) {
		return null;
	}
	return {
		id,
		label,
		usedPercent: Math.min(100, Math.max(0, 100 - percentRemaining)),
		resetsAt,
		// Monthly quota anchored to the billing date — no fixed duration.
		windowDurationMs: null,
	};
}

/** Maps a `copilot_internal/user` response to usage windows and a plan. */
export function parseCopilotUsage(
	json: unknown,
): { windows: UsageWindow[]; plan: string | null } | null {
	const parsed = copilotUsageSchema.safeParse(json);
	if (!parsed.success) return null;
	const data = parsed.data;

	const resetsAtMs = data.quota_reset_date
		? Date.parse(data.quota_reset_date)
		: Number.NaN;
	const resetsAt = Number.isFinite(resetsAtMs) ? resetsAtMs : null;

	const windows: UsageWindow[] = [];
	const premium = mapQuotaWindow(
		data.quota_snapshots?.premium_interactions,
		"premium_interactions",
		"Premium requests (monthly)",
		resetsAt,
	);
	const chat = mapQuotaWindow(
		data.quota_snapshots?.chat,
		"chat",
		"Chat (monthly)",
		resetsAt,
	);
	if (premium) windows.push(premium);
	if (chat) windows.push(chat);
	if (windows.length === 0) return null;

	return { windows, plan: formatPlanLabel(data.copilot_plan) };
}

export const copilotUsageProvider: UsageProvider = {
	id: "copilot",
	async fetchUsage(signal) {
		const credentials = await readCopilotToken();
		if (!credentials) {
			return createUsage({ status: "no-credentials" });
		}

		let response: Response;
		try {
			response = await fetch(COPILOT_USAGE_URL, {
				headers: {
					Authorization: `token ${credentials.token}`,
					Accept: "application/json",
					"User-Agent": "Superset",
				},
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
				errorMessage: `GitHub Copilot endpoint returned ${response.status}`,
			});
		}

		const json: unknown = await response.json().catch(() => null);
		const usage = parseCopilotUsage(json);
		if (!usage) {
			return createUsage({
				status: "error",
				errorMessage: "No metered Copilot quotas in the GitHub response",
			});
		}

		const account: ProviderAccount = {
			email: credentials.user,
			plan: usage.plan,
		};
		return createUsage({ status: "ok", windows: usage.windows, account });
	},
};
