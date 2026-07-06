import { Button } from "@superset/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { LuSettings2 } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";

export function UsageSettingsMenu() {
	const utils = electronTrpc.useUtils();
	const { data: preferences } =
		electronTrpc.providerUsage.getPreferences.useQuery();
	const setPreferences = electronTrpc.providerUsage.setPreferences.useMutation({
		onSuccess: () => utils.providerUsage.getPreferences.invalidate(),
	});

	if (!preferences) return null;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="h-8 text-muted-foreground"
					aria-label="Usage settings"
				>
					<LuSettings2 className="size-3.5" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-60">
				<DropdownMenuLabel>Usage display</DropdownMenuLabel>
				<DropdownMenuCheckboxItem
					checked={preferences.showBadge}
					onCheckedChange={(checked) =>
						setPreferences.mutate({ showBadge: checked === true })
					}
				>
					Sidebar badge
				</DropdownMenuCheckboxItem>
				<DropdownMenuCheckboxItem
					checked={preferences.showInTray}
					onCheckedChange={(checked) =>
						setPreferences.mutate({ showInTray: checked === true })
					}
				>
					Percentage in menu bar
				</DropdownMenuCheckboxItem>
				<DropdownMenuSeparator />
				<DropdownMenuCheckboxItem
					checked={preferences.notificationsEnabled}
					onCheckedChange={(checked) =>
						setPreferences.mutate({ notificationsEnabled: checked === true })
					}
				>
					Notify at 80% / 95% usage
				</DropdownMenuCheckboxItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
