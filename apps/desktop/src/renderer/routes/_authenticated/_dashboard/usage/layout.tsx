import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/_dashboard/usage")({
	component: UsageLayout,
});

function UsageLayout() {
	return <Outlet />;
}
