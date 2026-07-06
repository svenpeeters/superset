const usdFormatter = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
});

export function formatUsd(value: number): string {
	return usdFormatter.format(value);
}

export function formatTokens(value: number): string {
	if (value >= 1e9) {
		return `${(value / 1e9).toFixed(value >= 1e10 ? 0 : 1)}B`;
	}
	if (value >= 1e6) {
		return `${(value / 1e6).toFixed(value >= 1e8 ? 0 : 1)}M`;
	}
	if (value >= 1e3) {
		return `${(value / 1e3).toFixed(0)}K`;
	}
	return String(Math.round(value));
}
