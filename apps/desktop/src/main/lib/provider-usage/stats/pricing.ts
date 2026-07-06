/**
 * Per-1M-token API rates used to estimate local-log costs, CodexBar-style.
 * These are estimates: rates drift over time and subscription usage is not
 * actually billed per token. Unknown models count tokens but cost $0.
 */
export interface ModelPricing {
	inputPerMTok: number;
	outputPerMTok: number;
	cacheWrite5mPerMTok: number;
	cacheWrite1hPerMTok: number;
	cacheReadPerMTok: number;
}

function claudeRates(input: number, output: number): ModelPricing {
	return {
		inputPerMTok: input,
		outputPerMTok: output,
		cacheWrite5mPerMTok: input * 1.25,
		cacheWrite1hPerMTok: input * 2,
		cacheReadPerMTok: input * 0.1,
	};
}

function openAiRates(
	input: number,
	output: number,
	cachedInput: number,
): ModelPricing {
	return {
		inputPerMTok: input,
		outputPerMTok: output,
		cacheWrite5mPerMTok: input,
		cacheWrite1hPerMTok: input,
		cacheReadPerMTok: cachedInput,
	};
}

const MODEL_PRICING: Array<[RegExp, ModelPricing]> = [
	[/claude-(fable|mythos)/, claudeRates(10, 50)],
	[/claude-opus-4-[5-9]/, claudeRates(5, 25)],
	[/claude-opus/, claudeRates(15, 75)],
	[/claude-sonnet/, claudeRates(3, 15)],
	[/claude-haiku-4/, claudeRates(1, 5)],
	[/claude.*haiku/, claudeRates(0.8, 4)],
	[/gpt-5|codex/, openAiRates(1.25, 10, 0.125)],
	[/gpt-4o-mini/, openAiRates(0.15, 0.6, 0.075)],
	[/gpt-4/, openAiRates(2.5, 10, 1.25)],
];

export function getModelPricing(model: string): ModelPricing | null {
	for (const [pattern, pricing] of MODEL_PRICING) {
		if (pattern.test(model)) return pricing;
	}
	return null;
}

export interface TokenBreakdown {
	inputTokens: number;
	outputTokens: number;
	cacheWrite5mTokens: number;
	cacheWrite1hTokens: number;
	cacheReadTokens: number;
}

export function estimateCostUsd(model: string, tokens: TokenBreakdown): number {
	const pricing = getModelPricing(model);
	if (!pricing) return 0;
	return (
		(tokens.inputTokens * pricing.inputPerMTok +
			tokens.outputTokens * pricing.outputPerMTok +
			tokens.cacheWrite5mTokens * pricing.cacheWrite5mPerMTok +
			tokens.cacheWrite1hTokens * pricing.cacheWrite1hPerMTok +
			tokens.cacheReadTokens * pricing.cacheReadPerMTok) /
		1_000_000
	);
}

export function totalTokens(tokens: TokenBreakdown): number {
	return (
		tokens.inputTokens +
		tokens.outputTokens +
		tokens.cacheWrite5mTokens +
		tokens.cacheWrite1hTokens +
		tokens.cacheReadTokens
	);
}
