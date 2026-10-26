/**
 * Extension settings, read from Pi's effective settings under the `subagents`
 * key. Everything here is about what the extension is allowed to do without
 * asking; defaults are the cautious choice.
 *
 * Internal module — tests observe it through behaviour.
 */

import { isPositiveInteger } from "./validate.ts";

export type ConfirmMode = "ask" | "allow" | "deny";

export interface SubagentSettings {
	/** Whether project-level agents need consent before their first use. */
	confirmProjectAgents: ConfirmMode;
	/** Whether the model may author definitions with `create_subagent`. */
	allowModelCreatedDefinitions: boolean;
	/** Whether definitions may be written to the user-level directory. */
	allowUserScopeCreation: boolean;
	/** Maximum delegation depth: 1 allows one level of nesting, 2 allows two. */
	maxDepth: number;
	/** Default turn budget for delegations with none set (0 = unlimited). */
	defaultMaxTurns: number;
	/** Default wall-clock budget in milliseconds (0 = unlimited). */
	defaultTimeoutMs: number;
}

export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = {
	confirmProjectAgents: "ask",
	allowModelCreatedDefinitions: true,
	allowUserScopeCreation: false,
	maxDepth: 2,
	defaultMaxTurns: 50,
	defaultTimeoutMs: 600_000,
};

/**
 * Read and normalise the `subagents` settings object. Unknown or invalid values
 * fall back to defaults rather than failing a delegation; a boolean is accepted
 * for `confirmProjectAgents` for convenience (`true` asks, `false` denies).
 */
export function readSubagentSettings(raw: unknown): SubagentSettings {
	const value = (raw ?? {}) as Record<string, unknown>;
	return {
		confirmProjectAgents: readConfirmMode(value.confirmProjectAgents),
		allowModelCreatedDefinitions: readBoolean(
			value.allowModelCreatedDefinitions,
			DEFAULT_SUBAGENT_SETTINGS.allowModelCreatedDefinitions,
		),
		allowUserScopeCreation: readBoolean(
			value.allowUserScopeCreation,
			DEFAULT_SUBAGENT_SETTINGS.allowUserScopeCreation,
		),
		maxDepth: readPositiveInteger(value.maxDepth, DEFAULT_SUBAGENT_SETTINGS.maxDepth),
		defaultMaxTurns: readNonNegativeInteger(value.defaultMaxTurns, DEFAULT_SUBAGENT_SETTINGS.defaultMaxTurns),
		defaultTimeoutMs: readNonNegativeInteger(value.defaultTimeoutMs, DEFAULT_SUBAGENT_SETTINGS.defaultTimeoutMs),
	};
}

function readConfirmMode(value: unknown): ConfirmMode {
	if (value === "ask" || value === "allow" || value === "deny") return value;
	if (typeof value === "boolean") return value ? "ask" : "deny";
	return DEFAULT_SUBAGENT_SETTINGS.confirmProjectAgents;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/** Non-negative: `0` is valid here and means "no cap". */
function readNonNegativeInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function readPositiveInteger(value: unknown, fallback: number): number {
	return isPositiveInteger(value) ? value : fallback;
}
