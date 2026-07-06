import type { AgentType } from "@superset/shared/agent-command";

export type ProviderUsageStatus =
	| "ok"
	| "no-credentials"
	| "auth-expired"
	| "error"
	| "unsupported";

export interface UsageWindow {
	id: string;
	label: string;
	usedPercent: number;
	resetsAt: number | null;
	/** Total window length (e.g. 5h, 7d) — enables pace/reserve estimates. */
	windowDurationMs: number | null;
}

export interface ProviderCredits {
	balance: number;
	currency: string;
}

export interface ProviderAccount {
	email: string | null;
	plan: string | null;
}

export interface DailyStat {
	/** Local date, YYYY-MM-DD. */
	date: string;
	costUsd: number;
	tokens: number;
}

/** Cost/token statistics estimated from local agent logs at API rates. */
export interface ProviderStats {
	todayCostUsd: number;
	last30dCostUsd: number;
	last30dTokens: number;
	/** Total tokens of the most recent session. */
	latestTokens: number;
	/** Per-day aggregates for the last 30 days, oldest first. */
	daily: DailyStat[];
	topModel: string | null;
}

export interface ProviderUsage {
	providerId: AgentType;
	status: ProviderUsageStatus;
	windows: UsageWindow[];
	account: ProviderAccount | null;
	credits: ProviderCredits | null;
	/** Codex: number of manual rate-limit resets available. */
	manualResetsAvailable: number | null;
	costUsd: number | null;
	stats: ProviderStats | null;
	fetchedAt: number;
	/** For sources read from local files: when the data was actually produced. */
	dataAsOf: number | null;
	errorMessage: string | null;
}

export interface ProviderUsageSnapshot {
	providers: ProviderUsage[];
	collectedAt: number;
}

export interface UsageProvider {
	id: AgentType;
	fetchUsage(signal: AbortSignal): Promise<ProviderUsage>;
}
