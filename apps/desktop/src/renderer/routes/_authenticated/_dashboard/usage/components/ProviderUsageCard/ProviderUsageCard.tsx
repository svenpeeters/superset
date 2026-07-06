import { AGENT_LABELS } from "@superset/shared/agent-command";
import { cn } from "@superset/ui/utils";
import type {
	ProviderStats,
	ProviderUsage,
	UsageWindow,
} from "lib/trpc/routers/provider-usage.schema";
import {
	getPresetIcon,
	useIsDarkTheme,
} from "renderer/assets/app-icons/preset-icons";
import { formatDuration } from "./formatDuration";
import { formatTokens, formatUsd } from "./formatValues";
import { getPaceInfo } from "./paceInfo";

interface ProviderUsageCardProps {
	usage: ProviderUsage;
	now: number;
}

function getBarColorClass(usedPercent: number): string {
	if (usedPercent >= 90) return "bg-red-500/80";
	if (usedPercent >= 70) return "bg-amber-500/80";
	return "bg-foreground/40";
}

function UsageWindowRow({ window, now }: { window: UsageWindow; now: number }) {
	const pace = getPaceInfo(window, now);
	const leftPercent = Math.min(100, Math.max(0, 100 - window.usedPercent));

	return (
		<div>
			<div className="flex items-baseline justify-between gap-2">
				<span className="text-xs text-foreground">{window.label}</span>
				<span className="text-xs tabular-nums text-muted-foreground">
					<span className="font-semibold text-foreground">
						{Math.round(leftPercent)}%
					</span>{" "}
					left
				</span>
			</div>
			<div
				className="relative mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
				role="progressbar"
				aria-label={`${window.label} remaining`}
				aria-valuenow={Math.round(leftPercent)}
				aria-valuemin={0}
				aria-valuemax={100}
			>
				<div
					className={cn(
						"h-full rounded-full transition-[width] duration-300",
						getBarColorClass(window.usedPercent),
					)}
					style={{ width: `${leftPercent}%` }}
				/>
				{pace && (
					// Pace marker: where the fill would sit if quota burned linearly.
					<div
						className="absolute top-0 h-full w-0.5 bg-emerald-500/80"
						style={{ left: `${pace.remainingWindowPercent}%` }}
					/>
				)}
			</div>
			<div className="mt-1 flex items-baseline justify-between gap-2 text-[11px] tabular-nums text-muted-foreground/80">
				<span>
					{pace
						? `${Math.abs(Math.round(pace.reservePercent))}% ${
								pace.lastsUntilReset ? "in reserve" : "behind pace"
							}`
						: " "}
				</span>
				<span>
					{window.resetsAt !== null &&
						(window.resetsAt - now <= 0
							? "Reset due"
							: `Resets in ${formatDuration(window.resetsAt - now)}`)}
				</span>
			</div>
			{pace && (
				<div className="flex items-baseline justify-end text-[11px] text-muted-foreground/60">
					{pace.lastsUntilReset ? "Lasts until reset" : "May run out early"}
				</div>
			)}
		</div>
	);
}

function StatTile({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
				{label}
			</div>
			<div className="text-sm font-semibold tabular-nums text-foreground">
				{value}
			</div>
		</div>
	);
}

function formatChartDate(date: string): string {
	const parsed = new Date(`${date}T00:00:00`);
	if (Number.isNaN(parsed.getTime())) return date;
	return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function DailyCostChart({ stats }: { stats: ProviderStats }) {
	const maxCost = Math.max(...stats.daily.map((day) => day.costUsd), 0);
	if (maxCost <= 0) return null;

	return (
		<div
			className="flex h-10 items-end gap-px"
			role="img"
			aria-label="Daily cost, last 30 days"
		>
			{stats.daily.map((day, index) => {
				const heightPercent = (day.costUsd / maxCost) * 100;
				const isToday = index === stats.daily.length - 1;
				return (
					<div
						key={day.date}
						className="group relative flex h-full flex-1 items-end"
						title={`${formatChartDate(day.date)} · ${formatUsd(day.costUsd)} · ${formatTokens(day.tokens)} tokens`}
					>
						<div
							className={cn(
								"w-full rounded-t-[2px] transition-colors",
								isToday
									? "bg-foreground/70"
									: "bg-foreground/30 group-hover:bg-foreground/50",
							)}
							style={{
								height: `${Math.max(heightPercent, day.costUsd > 0 ? 4 : 0)}%`,
							}}
						/>
					</div>
				);
			})}
		</div>
	);
}

function StatsSection({ stats }: { stats: ProviderStats }) {
	return (
		<div className="flex flex-col gap-3 border-t border-border/60 pt-3">
			<div className="grid grid-cols-2 gap-x-4 gap-y-2">
				<StatTile label="Today" value={formatUsd(stats.todayCostUsd)} />
				<StatTile label="30d cost" value={formatUsd(stats.last30dCostUsd)} />
				<StatTile
					label="30d tokens"
					value={formatTokens(stats.last30dTokens)}
				/>
				<StatTile
					label="Latest tokens"
					value={formatTokens(stats.latestTokens)}
				/>
			</div>
			<DailyCostChart stats={stats} />
			<div className="flex flex-col gap-0.5">
				{stats.topModel && (
					<div className="text-[11px] text-muted-foreground">
						Top model:{" "}
						<span className="text-foreground/80">{stats.topModel}</span>
					</div>
				)}
				<div className="text-[10px] text-muted-foreground/60">
					Estimated from local logs at API rates.
				</div>
			</div>
		</div>
	);
}

function StatusMessage({ usage }: { usage: ProviderUsage }) {
	const label = AGENT_LABELS[usage.providerId];
	switch (usage.status) {
		case "no-credentials":
			return (
				<p className="text-xs text-muted-foreground">
					Not signed in — log in via the {label} CLI to see usage.
				</p>
			);
		case "auth-expired":
			return (
				<p className="text-xs text-amber-600 dark:text-amber-500">
					Session expired — re-authenticate the {label} CLI.
				</p>
			);
		case "unsupported":
			return (
				<p className="text-xs text-muted-foreground">
					Usage data not available yet.
				</p>
			);
		case "error":
			return (
				<p className="select-text cursor-text text-xs text-red-600 dark:text-red-500">
					{usage.errorMessage ?? "Failed to load usage."}
				</p>
			);
		default:
			return null;
	}
}

export function ProviderUsageCard({ usage, now }: ProviderUsageCardProps) {
	const label = AGENT_LABELS[usage.providerId];
	const isDark = useIsDarkTheme();
	const icon = getPresetIcon(usage.providerId, isDark);
	const updatedAt = usage.dataAsOf ?? usage.fetchedAt;
	const showBody = usage.status === "ok" || usage.stats !== null;

	return (
		<div
			className={cn(
				"rounded-lg border border-border p-3.5",
				usage.status === "unsupported" && "opacity-60",
			)}
		>
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					{icon && (
						<img src={icon} alt="" className="size-4 shrink-0 object-contain" />
					)}
					<h3 className="text-base font-semibold tracking-[0.02em]">{label}</h3>
				</div>
				{usage.account?.email && (
					<span className="truncate text-[11px] text-muted-foreground">
						{usage.account.email}
					</span>
				)}
			</div>
			<div className="mt-0.5 flex items-baseline justify-between gap-2">
				<span className="text-[11px] tabular-nums text-muted-foreground/70">
					{now - updatedAt < 60_000
						? "Updated just now"
						: `Updated ${formatDuration(now - updatedAt)} ago`}
				</span>
				{usage.account?.plan && (
					<span className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
						{usage.account.plan}
					</span>
				)}
			</div>

			{usage.status !== "ok" && (
				<div className="mt-2">
					<StatusMessage usage={usage} />
				</div>
			)}

			{showBody && (
				<div className="mt-3 flex flex-col gap-3.5">
					{usage.windows.map((window) => (
						<UsageWindowRow key={window.id} window={window} now={now} />
					))}
					{usage.credits && (
						<div className="flex items-baseline justify-between gap-2">
							<span className="text-xs text-muted-foreground">Credits</span>
							<span className="text-xs font-semibold tabular-nums">
								{usage.credits.balance.toFixed(2)} {usage.credits.currency}
							</span>
						</div>
					)}
					{usage.manualResetsAvailable !== null && (
						<div className="flex items-baseline justify-between gap-2">
							<span className="text-xs text-muted-foreground">
								Limit reset credits
							</span>
							<span className="text-xs font-semibold tabular-nums">
								{usage.manualResetsAvailable} available
							</span>
						</div>
					)}
					{usage.stats && <StatsSection stats={usage.stats} />}
				</div>
			)}
		</div>
	);
}
