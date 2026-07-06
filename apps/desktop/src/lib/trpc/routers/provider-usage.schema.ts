import { AGENT_TYPES } from "@superset/shared/agent-command";
import type { z } from "zod";
import { z as zod } from "zod";

const percentSchema = zod.number().finite().min(0).max(100);

const usageWindowSchema = zod.object({
	id: zod.string().min(1),
	label: zod.string().min(1),
	usedPercent: percentSchema,
	resetsAt: zod.number().finite().nullable(),
	windowDurationMs: zod.number().finite().positive().nullable(),
});

const providerUsageStatusSchema = zod.enum([
	"ok",
	"no-credentials",
	"auth-expired",
	"error",
	"unsupported",
]);

const providerAccountSchema = zod.object({
	email: zod.string().nullable(),
	plan: zod.string().nullable(),
});

const dailyStatSchema = zod.object({
	date: zod.string().min(1),
	costUsd: zod.number().finite().min(0),
	tokens: zod.number().finite().min(0),
});

const providerStatsSchema = zod.object({
	todayCostUsd: zod.number().finite().min(0),
	last30dCostUsd: zod.number().finite().min(0),
	last30dTokens: zod.number().finite().min(0),
	latestTokens: zod.number().finite().min(0),
	daily: zod.array(dailyStatSchema),
	topModel: zod.string().nullable(),
});

const providerUsageSchema = zod.object({
	providerId: zod.enum(AGENT_TYPES),
	status: providerUsageStatusSchema,
	windows: zod.array(usageWindowSchema),
	account: providerAccountSchema.nullable(),
	credits: zod
		.object({
			balance: zod.number().finite(),
			currency: zod.string().min(1),
		})
		.nullable(),
	manualResetsAvailable: zod.number().finite().min(0).nullable(),
	costUsd: zod.number().finite().nullable(),
	stats: providerStatsSchema.nullable(),
	fetchedAt: zod.number().int().min(0),
	dataAsOf: zod.number().finite().nullable(),
	errorMessage: zod.string().nullable(),
});

export const providerUsageSnapshotSchema = zod.object({
	providers: zod.array(providerUsageSchema),
	collectedAt: zod.number().int().min(0),
});

export type ProviderUsageSnapshot = z.infer<typeof providerUsageSnapshotSchema>;
export type ProviderUsage = z.infer<typeof providerUsageSchema>;
export type ProviderUsageStatus = z.infer<typeof providerUsageStatusSchema>;
export type ProviderStats = z.infer<typeof providerStatsSchema>;
export type UsageWindow = z.infer<typeof usageWindowSchema>;

export function createFallbackProviderUsageSnapshot(): ProviderUsageSnapshot {
	return {
		providers: AGENT_TYPES.map((providerId) => ({
			providerId,
			status: "error" as const,
			windows: [],
			account: null,
			credits: null,
			manualResetsAvailable: null,
			costUsd: null,
			stats: null,
			fetchedAt: Date.now(),
			dataAsOf: null,
			errorMessage: "Usage data unavailable",
		})),
		collectedAt: Date.now(),
	};
}

interface ProviderUsageValidationResult {
	isValid: boolean;
	snapshot: ProviderUsageSnapshot;
	issues: z.ZodIssue[];
}

export function validateProviderUsageSnapshot(
	snapshot: unknown,
): ProviderUsageValidationResult {
	const parsed = providerUsageSnapshotSchema.safeParse(snapshot);
	if (parsed.success) {
		return { isValid: true, snapshot: parsed.data, issues: [] };
	}

	return {
		isValid: false,
		snapshot: createFallbackProviderUsageSnapshot(),
		issues: parsed.error.issues,
	};
}
