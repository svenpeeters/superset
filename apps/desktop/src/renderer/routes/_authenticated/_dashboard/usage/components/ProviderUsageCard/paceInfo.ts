import type { UsageWindow } from "lib/trpc/routers/provider-usage.schema";

export interface PaceInfo {
	leftPercent: number;
	/** Fraction of the window that has not elapsed yet, as a percentage. */
	remainingWindowPercent: number;
	/** How far ahead of linear burn you are; negative = burning too fast. */
	reservePercent: number;
	lastsUntilReset: boolean;
}

export function getPaceInfo(window: UsageWindow, now: number): PaceInfo | null {
	const leftPercent = Math.min(100, Math.max(0, 100 - window.usedPercent));
	if (
		window.resetsAt === null ||
		window.windowDurationMs === null ||
		window.windowDurationMs <= 0
	) {
		return null;
	}
	const remainingMs = window.resetsAt - now;
	const remainingWindowPercent = Math.min(
		100,
		Math.max(0, (remainingMs / window.windowDurationMs) * 100),
	);
	const reservePercent = leftPercent - remainingWindowPercent;
	return {
		leftPercent,
		remainingWindowPercent,
		reservePercent,
		lastsUntilReset: reservePercent >= 0,
	};
}
