import { describe, expect, it } from "bun:test";
import { formatDuration } from "./formatDuration";

describe("formatDuration", () => {
	it("formats minutes", () => {
		expect(formatDuration(5 * 60_000)).toBe("5m");
	});

	it("formats hours and minutes", () => {
		expect(formatDuration((2 * 60 + 14) * 60_000)).toBe("2h 14m");
	});

	it("formats days and hours", () => {
		expect(formatDuration((3 * 24 + 5) * 60 * 60_000)).toBe("3d 5h");
	});

	it("returns now for elapsed durations", () => {
		expect(formatDuration(0)).toBe("now");
		expect(formatDuration(-1000)).toBe("now");
	});
});
