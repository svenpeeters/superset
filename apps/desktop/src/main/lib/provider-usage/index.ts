import fs from "node:fs/promises";
import path from "node:path";
import type { AgentType } from "@superset/shared/agent-command";
import { AGENT_TYPES } from "@superset/shared/agent-command";
import { SUPERSET_HOME_DIR } from "main/lib/app-environment";
import { claudeUsageProvider } from "./providers/claude";
import { codexUsageProvider } from "./providers/codex";
import { copilotUsageProvider } from "./providers/copilot";
import { geminiUsageProvider } from "./providers/gemini";
import { createUnsupportedProvider } from "./providers/unsupported";
import type {
	ProviderUsage,
	ProviderUsageSnapshot,
	UsageProvider,
} from "./types";

export type {
	ProviderUsage,
	ProviderUsageSnapshot,
	ProviderUsageStatus,
	UsageWindow,
} from "./types";

type SnapshotMode = "interactive" | "idle";

interface CollectProviderUsageOptions {
	mode?: SnapshotMode;
	force?: boolean;
}

// Provider usage moves slowly; refreshing more than once a minute only
// hammers unofficial endpoints without changing what the UI shows.
const SNAPSHOT_MAX_AGE_MS: Record<SnapshotMode, number> = {
	interactive: 60_000,
	idle: 300_000,
};

const FETCH_TIMEOUT_MS = 10_000;

const implementedProviders: Partial<Record<AgentType, UsageProvider>> = {
	claude: claudeUsageProvider,
	codex: codexUsageProvider,
	copilot: copilotUsageProvider,
	gemini: geminiUsageProvider,
};

// Built from the shared agent registry so newly added agents automatically
// surface as "unsupported" instead of being forgotten.
const providers: UsageProvider[] = AGENT_TYPES.map(
	(id) => implementedProviders[id] ?? createUnsupportedProvider(id),
);

const providerCache = new Map<AgentType, ProviderUsage>();
let cachedSnapshot: ProviderUsageSnapshot | null = null;
let inflightCollection: Promise<ProviderUsageSnapshot> | null = null;
let loadedFromDisk = false;

type SnapshotListener = (snapshot: ProviderUsageSnapshot) => void;
const snapshotListeners: SnapshotListener[] = [];

export function onProviderUsageSnapshot(listener: SnapshotListener): void {
	snapshotListeners.push(listener);
}

const SNAPSHOT_DISK_PATH = () =>
	path.join(SUPERSET_HOME_DIR, "usage-snapshot.json");

async function loadSnapshotFromDisk(): Promise<void> {
	if (loadedFromDisk) return;
	loadedFromDisk = true;
	try {
		const raw = await fs.readFile(SNAPSHOT_DISK_PATH(), "utf8");
		const snapshot = JSON.parse(raw) as ProviderUsageSnapshot;
		if (Array.isArray(snapshot.providers) && !cachedSnapshot) {
			cachedSnapshot = snapshot;
			for (const provider of snapshot.providers) {
				providerCache.set(provider.providerId, provider);
			}
		}
	} catch {
		// No persisted snapshot yet.
	}
}

function persistSnapshotToDisk(snapshot: ProviderUsageSnapshot): void {
	fs.writeFile(SNAPSHOT_DISK_PATH(), JSON.stringify(snapshot), {
		mode: 0o600,
	}).catch(() => {
		// Best-effort cache.
	});
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

function normalizeUsage(usage: ProviderUsage): ProviderUsage {
	return {
		...usage,
		windows: usage.windows.map((window) => ({
			...window,
			usedPercent: clampPercent(window.usedPercent),
			resetsAt:
				typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)
					? window.resetsAt
					: null,
			windowDurationMs:
				typeof window.windowDurationMs === "number" &&
				Number.isFinite(window.windowDurationMs) &&
				window.windowDurationMs > 0
					? window.windowDurationMs
					: null,
		})),
	};
}

async function fetchProviderUsage(
	provider: UsageProvider,
): Promise<ProviderUsage> {
	try {
		const usage = await provider.fetchUsage(
			AbortSignal.timeout(FETCH_TIMEOUT_MS),
		);
		const normalized = normalizeUsage(usage);
		providerCache.set(provider.id, normalized);
		return normalized;
	} catch (error) {
		// A provider failure reuses its own last good result so one flaky
		// source never blanks the rest of the snapshot.
		const cached = providerCache.get(provider.id);
		if (cached) return cached;
		return {
			providerId: provider.id,
			status: "error",
			windows: [],
			account: null,
			credits: null,
			manualResetsAvailable: null,
			costUsd: null,
			stats: null,
			fetchedAt: Date.now(),
			dataAsOf: null,
			errorMessage:
				error instanceof Error ? error.message : "Failed to fetch usage",
		};
	}
}

async function collectProviderUsageNow(): Promise<ProviderUsageSnapshot> {
	const results = await Promise.all(providers.map(fetchProviderUsage));
	const snapshot: ProviderUsageSnapshot = {
		providers: results,
		collectedAt: Date.now(),
	};
	cachedSnapshot = snapshot;
	persistSnapshotToDisk(snapshot);
	for (const listener of snapshotListeners) {
		try {
			listener(snapshot);
		} catch (error) {
			console.warn("[provider-usage] Snapshot listener failed", error);
		}
	}
	return snapshot;
}

export async function collectProviderUsage(
	options: CollectProviderUsageOptions = {},
): Promise<ProviderUsageSnapshot> {
	const mode = options.mode ?? "interactive";
	const maxAgeMs = SNAPSHOT_MAX_AGE_MS[mode];

	await loadSnapshotFromDisk();
	if (!options.force && cachedSnapshot) {
		const ageMs = Date.now() - cachedSnapshot.collectedAt;
		if (ageMs <= maxAgeMs) {
			return cachedSnapshot;
		}
	}

	if (inflightCollection) {
		return inflightCollection;
	}

	inflightCollection = collectProviderUsageNow().finally(() => {
		inflightCollection = null;
	});
	return inflightCollection;
}
