import { AGENT_LABELS } from "@superset/shared/agent-command";
import type { ProviderUsage } from "lib/trpc/routers/provider-usage.schema";
import {
	getPresetIcon,
	useIsDarkTheme,
} from "renderer/assets/app-icons/preset-icons";

interface DormantProvidersStripProps {
	providers: ProviderUsage[];
}

/** Compact strip listing providers without usage data, instead of one near-empty card per provider. */
export function DormantProvidersStrip({
	providers,
}: DormantProvidersStripProps) {
	const isDark = useIsDarkTheme();
	if (providers.length === 0) return null;

	return (
		<div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-lg border border-dashed border-border px-4 py-3">
			<span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
				<span className="mr-1.5">○</span>
				No data yet
			</span>
			{providers.map((provider) => {
				const icon = getPresetIcon(provider.providerId, isDark);
				return (
					<span
						key={provider.providerId}
						className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
					>
						{icon ? (
							<img
								src={icon}
								alt=""
								className="size-3 shrink-0 object-contain opacity-70"
							/>
						) : (
							<span className="text-muted-foreground/50">○</span>
						)}
						{AGENT_LABELS[provider.providerId]}
					</span>
				);
			})}
		</div>
	);
}
