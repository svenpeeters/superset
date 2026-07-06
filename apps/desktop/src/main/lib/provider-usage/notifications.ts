import { AGENT_LABELS } from "@superset/shared/agent-command";
import { Notification } from "electron";
import { getUsagePreferences } from "./preferences";
import type { ProviderUsageSnapshot } from "./types";

const THRESHOLDS = [80, 95];

// Highest threshold already notified per provider window; cleared when usage
// drops back below the lowest threshold (i.e. the window reset).
const notifiedThresholds = new Map<string, number>();

export function checkUsageNotifications(snapshot: ProviderUsageSnapshot): void {
	if (!getUsagePreferences().notificationsEnabled) return;
	if (!Notification.isSupported()) return;

	for (const provider of snapshot.providers) {
		if (provider.status !== "ok") continue;
		for (const window of provider.windows) {
			const key = `${provider.providerId}:${window.id}`;
			const crossed = THRESHOLDS.filter((t) => window.usedPercent >= t).pop();
			const previous = notifiedThresholds.get(key) ?? 0;

			if (!crossed) {
				if (previous) notifiedThresholds.delete(key);
				continue;
			}
			if (crossed <= previous) continue;

			notifiedThresholds.set(key, crossed);
			const label = AGENT_LABELS[provider.providerId];
			new Notification({
				title: `${label} usage at ${Math.round(window.usedPercent)}%`,
				body: `${window.label} is ${Math.round(window.usedPercent)}% used.`,
				silent: crossed < 95,
			}).show();
		}
	}
}
