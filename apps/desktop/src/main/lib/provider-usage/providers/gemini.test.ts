import { describe, expect, it } from "bun:test";
import {
	extractOAuthClient,
	mapGeminiQuotaWindows,
	parseIdTokenEmail,
} from "./gemini";

describe("extractOAuthClient", () => {
	it("extracts the installed-app client from a CLI bundle", () => {
		const source = `
			const OAUTH_CLIENT_ID = "12345-abcdef.apps.googleusercontent.com";
			const OAUTH_CLIENT_SECRET = "not-actually-secret";
		`;
		expect(extractOAuthClient(source)).toEqual({
			clientId: "12345-abcdef.apps.googleusercontent.com",
			clientSecret: "not-actually-secret",
		});
	});

	it("requires both constants and a googleusercontent client id", () => {
		expect(
			extractOAuthClient(
				`const OAUTH_CLIENT_ID = "12345.apps.googleusercontent.com";`,
			),
		).toBeNull();
		expect(
			extractOAuthClient(
				`const OAUTH_CLIENT_ID = "nope"; const OAUTH_CLIENT_SECRET = "x";`,
			),
		).toBeNull();
	});
});

describe("mapGeminiQuotaWindows", () => {
	it("maps quota buckets to one daily window per model", () => {
		const windows = mapGeminiQuotaWindows({
			buckets: [
				{
					modelId: "gemini-3-pro",
					remainingFraction: 0.4,
					resetTime: "2026-07-18T07:00:00Z",
				},
				{ modelId: "gemini-3-flash", remainingFraction: 0.95 },
			],
		});

		expect(windows).toHaveLength(2);
		expect(windows?.[1]).toMatchObject({
			id: "daily_gemini-3-pro",
			label: "Daily (gemini-3-pro)",
			usedPercent: 60,
			resetsAt: Date.parse("2026-07-18T07:00:00Z"),
			windowDurationMs: 24 * 60 * 60 * 1000,
		});
		expect(windows?.[0]?.usedPercent).toBeCloseTo(5);
	});

	it("keeps the most-used bucket per model", () => {
		const windows = mapGeminiQuotaWindows({
			buckets: [
				{ modelId: "gemini-3-pro", remainingFraction: 0.9 },
				{ modelId: "gemini-3-pro", remainingFraction: 0.2 },
			],
		});
		expect(windows).toHaveLength(1);
		expect(windows?.[0]?.usedPercent).toBeCloseTo(80);
	});

	it("skips buckets without a model or fraction", () => {
		expect(
			mapGeminiQuotaWindows({
				buckets: [{ modelId: "gemini-3-pro" }, { remainingFraction: 0.5 }],
			}),
		).toBeNull();
	});

	it("returns null for unrecognized payloads", () => {
		expect(mapGeminiQuotaWindows(null)).toBeNull();
		expect(mapGeminiQuotaWindows({})).toBeNull();
		expect(mapGeminiQuotaWindows({ buckets: [] })).toBeNull();
	});
});

describe("parseIdTokenEmail", () => {
	it("extracts the email claim from a JWT payload", () => {
		const payload = Buffer.from(
			JSON.stringify({ email: "dev@example.com" }),
		).toString("base64url");
		expect(parseIdTokenEmail(`header.${payload}.sig`)).toBe("dev@example.com");
	});

	it("returns null for malformed tokens", () => {
		expect(parseIdTokenEmail(null)).toBeNull();
		expect(parseIdTokenEmail("not-a-jwt")).toBeNull();
		expect(parseIdTokenEmail("a.!!!.c")).toBeNull();
	});
});
