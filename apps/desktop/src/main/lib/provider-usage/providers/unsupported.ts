import type { AgentType } from "@superset/shared/agent-command";
import type { UsageProvider } from "../types";

export function createUnsupportedProvider(id: AgentType): UsageProvider {
	return {
		id,
		async fetchUsage() {
			return {
				providerId: id,
				status: "unsupported",
				windows: [],
				account: null,
				credits: null,
				manualResetsAvailable: null,
				costUsd: null,
				stats: null,
				fetchedAt: Date.now(),
				dataAsOf: null,
				errorMessage: null,
			};
		},
	};
}
