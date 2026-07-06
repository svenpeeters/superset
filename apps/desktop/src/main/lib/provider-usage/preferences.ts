import fs from "node:fs";
import path from "node:path";
import { SUPERSET_HOME_DIR } from "main/lib/app-environment";
import { z } from "zod";

const PREFERENCES_PATH = path.join(SUPERSET_HOME_DIR, "usage-preferences.json");

const preferencesSchema = z.object({
	showBadge: z.boolean(),
	showInTray: z.boolean(),
	notificationsEnabled: z.boolean(),
});

export type UsagePreferences = z.infer<typeof preferencesSchema>;

const DEFAULT_PREFERENCES: UsagePreferences = {
	showBadge: true,
	showInTray: true,
	notificationsEnabled: true,
};

let cached: UsagePreferences | null = null;

export function getUsagePreferences(): UsagePreferences {
	if (cached) return cached;
	try {
		const parsed = preferencesSchema.safeParse(
			JSON.parse(fs.readFileSync(PREFERENCES_PATH, "utf8")),
		);
		cached = parsed.success ? parsed.data : DEFAULT_PREFERENCES;
	} catch {
		cached = DEFAULT_PREFERENCES;
	}
	return cached;
}

export function setUsagePreferences(
	update: Partial<UsagePreferences>,
): UsagePreferences {
	const next = { ...getUsagePreferences(), ...update };
	cached = next;
	try {
		fs.writeFileSync(PREFERENCES_PATH, JSON.stringify(next, null, "\t"), {
			mode: 0o600,
		});
	} catch (error) {
		console.warn("[provider-usage] Failed to persist preferences", error);
	}
	return next;
}
