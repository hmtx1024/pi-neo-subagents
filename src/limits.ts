/**
 * Budget and thinking validation shared by the `task` tool, the nested
 * delegation tool, and definition creation.
 *
 * Internal module — tests observe it through error messages.
 */

import { THINKING_LEVELS, type DefinitionThinking } from "./agents.ts";
import { isPositiveInteger } from "./validate.ts";

/** Budget overrides; each value must be a positive integer. */
export interface RawLimits {
	maxTurns?: number;
	maxTokens?: number;
	timeoutMs?: number;
	thinking?: string;
}

export interface ParsedLimits {
	maxTurns?: number;
	maxTokens?: number;
	timeoutMs?: number;
	thinking?: DefinitionThinking;
}

/** Positive-integer validation; a bad value is a caller error naming the field. */
export function positiveInteger(name: string, value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!isPositiveInteger(value)) {
		throw new Error(`${name} must be a positive integer (got ${value}).`);
	}
	return value;
}

/** Thinking-level validation against the levels Pi accepts. */
export function thinkingOverride(value: string | undefined): DefinitionThinking | undefined {
	if (value === undefined) return undefined;
	if (!(THINKING_LEVELS as readonly string[]).includes(value)) {
		throw new Error(`thinking must be one of: ${THINKING_LEVELS.join(", ")} (got "${value}").`);
	}
	return value as DefinitionThinking;
}

/** Validate a full set of overrides at once. */
export function parseLimits(raw: RawLimits): ParsedLimits {
	return {
		maxTurns: positiveInteger("maxTurns", raw.maxTurns),
		maxTokens: positiveInteger("maxTokens", raw.maxTokens),
		timeoutMs: positiveInteger("timeoutMs", raw.timeoutMs),
		thinking: thinkingOverride(raw.thinking),
	};
}
