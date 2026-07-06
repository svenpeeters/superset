import { describe, expect, it } from "bun:test";
import { getPaceInfo } from "./paceInfo";

const HOUR = 60 * 60 * 1000;

describe("getPaceInfo", () => {
	it("computes reserve vs linear burn (matches CodexBar semantics)", () => {
		// 5h window, 1% used, resets in ~1h46m → ~64% reserve
		const now = Date.parse("2026-07-03T10:00:00Z");
		const info = getPaceInfo(
			{
				id: "primary",
				label: "Session",
				usedPercent: 1,
				resetsAt: now + 1.77 * HOUR,
				windowDurationMs: 5 * HOUR,
			},
			now,
		);
		expect(info?.leftPercent).toBe(99);
		expect(Math.round(info?.reservePercent ?? 0)).toBe(64);
		expect(info?.lastsUntilReset).toBe(true);
	});

	it("flags burning faster than the window elapses", () => {
		const now = 0;
		const info = getPaceInfo(
			{
				id: "w",
				label: "W",
				usedPercent: 90,
				resetsAt: now + 4 * HOUR,
				windowDurationMs: 5 * HOUR,
			},
			now,
		);
		expect(info?.leftPercent).toBe(10);
		expect(info?.reservePercent).toBeCloseTo(10 - 80, 5);
		expect(info?.lastsUntilReset).toBe(false);
	});

	it("returns null without reset time or window duration", () => {
		const base = { id: "w", label: "W", usedPercent: 10 };
		expect(
			getPaceInfo({ ...base, resetsAt: null, windowDurationMs: 1 }, 0),
		).toBeNull();
		expect(
			getPaceInfo({ ...base, resetsAt: 100, windowDurationMs: null }, 0),
		).toBeNull();
	});

	it("clamps an already-elapsed window", () => {
		const info = getPaceInfo(
			{
				id: "w",
				label: "W",
				usedPercent: 50,
				resetsAt: -100,
				windowDurationMs: 100,
			},
			0,
		);
		expect(info?.remainingWindowPercent).toBe(0);
		expect(info?.reservePercent).toBe(50);
	});
});
