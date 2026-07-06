import { collectProviderUsage } from "main/lib/provider-usage";
import {
	getUsagePreferences,
	setUsagePreferences,
} from "main/lib/provider-usage/preferences";
import { z } from "zod";
import { publicProcedure, router } from "..";
import {
	providerUsageSnapshotSchema,
	validateProviderUsageSnapshot,
} from "./provider-usage.schema";

const getSnapshotInputSchema = z
	.object({
		mode: z.enum(["interactive", "idle"]).optional(),
		force: z.boolean().optional(),
	})
	.optional();

export const createProviderUsageRouter = () => {
	return router({
		getSnapshot: publicProcedure
			.input(getSnapshotInputSchema)
			.output(providerUsageSnapshotSchema)
			.query(async ({ input }) => {
				const snapshot = await collectProviderUsage({
					mode: input?.mode,
					force: input?.force,
				});
				const validation = validateProviderUsageSnapshot(snapshot);
				if (!validation.isValid) {
					console.warn(
						"[provider-usage] Invalid snapshot payload; returning fallback snapshot",
						validation.issues,
					);
				}
				return validation.snapshot;
			}),

		getPreferences: publicProcedure.query(() => getUsagePreferences()),

		setPreferences: publicProcedure
			.input(
				z.object({
					showBadge: z.boolean().optional(),
					showInTray: z.boolean().optional(),
					notificationsEnabled: z.boolean().optional(),
				}),
			)
			.mutation(({ input }) => setUsagePreferences(input)),
	});
};
