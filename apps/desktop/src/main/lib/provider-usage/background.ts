import { setTrayUsageTitle } from "../tray";
import { collectProviderUsage, onProviderUsageSnapshot } from ".";
import { checkUsageNotifications } from "./notifications";
import { getUsagePreferences } from "./preferences";
import type { ProviderUsageSnapshot } from "./types";

const BACKGROUND_INTERVAL_MS = 5 * 60_000;
const INITIAL_DELAY_MS = 15_000;

function worstUsedPercent(snapshot: ProviderUsageSnapshot): number | null {
	let worst: number | null = null;
	for (const provider of snapshot.providers) {
		if (provider.status !== "ok") continue;
		for (const window of provider.windows) {
			if (worst === null || window.usedPercent > worst) {
				worst = window.usedPercent;
			}
		}
	}
	return worst;
}

function handleSnapshot(snapshot: ProviderUsageSnapshot): void {
	checkUsageNotifications(snapshot);
	const worst = getUsagePreferences().showInTray
		? worstUsedPercent(snapshot)
		: null;
	setTrayUsageTitle(worst === null ? "" : `${Math.round(worst)}%`);
}

/**
 * Keeps usage fresh even while the Usage UI is closed, so the tray
 * percentage and threshold notifications work CodexBar-style.
 */
export function startProviderUsageBackground(): void {
	onProviderUsageSnapshot(handleSnapshot);

	const tick = () => {
		void collectProviderUsage({ mode: "idle" }).catch(() => {
			// Collection failures already degrade gracefully per provider.
		});
	};
	setTimeout(tick, INITIAL_DELAY_MS).unref?.();
	setInterval(tick, BACKGROUND_INTERVAL_MS).unref?.();
}
