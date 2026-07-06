import { AGENT_LABELS } from "@superset/shared/agent-command";
import { Popover, PopoverContent, PopoverTrigger } from "@superset/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { LuGauge } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { formatDuration } from "renderer/routes/_authenticated/_dashboard/usage/components/ProviderUsageCard/formatDuration";
import {
	getActiveProviders,
	getUsageSeverity,
	getWorstUtilization,
	getWorstWindow,
	type UsageSeverity,
} from "./usageBadgePolicy";

const SEVERITY_TEXT_CLASSES: Record<UsageSeverity, string> = {
	normal: "text-muted-foreground hover:text-foreground",
	elevated: "text-amber-600 dark:text-amber-500",
	high: "text-red-600 dark:text-red-500",
};

interface UsageBadgeProps {
	variant?: "expanded" | "collapsed";
	className?: string;
}

export function UsageBadge({
	variant = "expanded",
	className,
}: UsageBadgeProps) {
	const [open, setOpen] = useState(false);
	const navigate = useNavigate();

	const { data: preferences } =
		electronTrpc.providerUsage.getPreferences.useQuery();
	const { data: snapshot } = electronTrpc.providerUsage.getSnapshot.useQuery(
		{ mode: "idle" },
		{ refetchInterval: 60_000, enabled: preferences?.showBadge !== false },
	);

	const worst = getWorstUtilization(snapshot);
	if (preferences?.showBadge === false || worst === null) return null;

	const severity = getUsageSeverity(worst);
	const activeProviders = getActiveProviders(snapshot);
	const now = Date.now();

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip delayDuration={150}>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<button
							type="button"
							aria-label="AI provider usage"
							className={cn(
								"no-drag flex items-center gap-1 rounded-md transition-colors",
								variant === "collapsed"
									? "h-8 w-8 flex-col justify-center gap-0"
									: "h-6 px-1.5",
								"hover:bg-accent/50",
								SEVERITY_TEXT_CLASSES[severity],
								className,
							)}
						>
							<LuGauge
								className={variant === "collapsed" ? "size-3.5" : "size-3"}
							/>
							<span
								className={cn(
									"font-medium tabular-nums",
									variant === "collapsed" ? "text-[9px]" : "text-[11px]",
								)}
							>
								{Math.round(worst)}%
							</span>
						</button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent
					side={variant === "collapsed" ? "right" : "bottom"}
					sideOffset={6}
					showArrow={false}
				>
					AI provider usage
				</TooltipContent>
			</Tooltip>

			<PopoverContent
				align={variant === "collapsed" ? "start" : "end"}
				side={variant === "collapsed" ? "right" : "bottom"}
				className="w-72 p-0 overflow-hidden"
			>
				<div className="border-b border-border/60 px-3.5 py-2.5">
					<h4 className="text-[13px] font-medium tracking-tight text-foreground">
						AI provider usage
					</h4>
				</div>
				<div className="flex flex-col gap-2 px-3.5 py-2.5">
					{activeProviders.map((provider) => {
						const window = getWorstWindow(provider);
						if (!window) return null;
						return (
							<div
								key={provider.providerId}
								className="flex items-baseline justify-between gap-2"
							>
								<span className="text-xs text-foreground">
									{AGENT_LABELS[provider.providerId]}
								</span>
								<span className="text-[11px] tabular-nums text-muted-foreground">
									<span
										className={cn(
											"font-medium",
											SEVERITY_TEXT_CLASSES[
												getUsageSeverity(window.usedPercent)
											],
										)}
									>
										{Math.round(window.usedPercent)}%
									</span>
									{window.resetsAt !== null && (
										<> · resets in {formatDuration(window.resetsAt - now)}</>
									)}
								</span>
							</div>
						);
					})}
				</div>
				<button
					type="button"
					onClick={() => {
						setOpen(false);
						navigate({ to: "/usage" });
					}}
					className="w-full border-t border-border/60 px-3.5 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
				>
					View details →
				</button>
			</PopoverContent>
		</Popover>
	);
}
