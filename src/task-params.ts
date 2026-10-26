/**
 * The `task` tool's public contract: parameter schemas and the parsing that
 * turns one call into a task dispatch shape. Descriptions here are
 * load-bearing — they are the host's per-turn token cost, and
 * `test/schema-slimming.test.ts` guards their size and honesty.
 */

import { Type } from "@earendil-works/pi-ai";

import { THINKING_LEVELS } from "./agents.ts";
import { delegationTarget } from "./delegate.ts";
import type { DispatchTask, TaskOutcome } from "./dispatch.ts";
import { parseLimits } from "./limits.ts";
import type { SubagentSettings } from "./settings.ts";

export const taskEntryParameters = Type.Object({
	agent: Type.Optional(Type.String({ description: "definition name" })),
	instructions: Type.Optional(Type.String({ description: "persona (default generic worker)" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "built-ins + host extensions; a list narrows" })),
	model: Type.Optional(Type.String({ description: '"provider/id" (default: inherit)' })),
	task: Type.String({ description: "self-contained task" }),
	maxTurns: Type.Optional(Type.Number({ description: "turn cap (overrides)" })),
	maxTokens: Type.Optional(Type.Number({ description: "token cap (overrides)" })),
	timeoutMs: Type.Optional(Type.Number({ description: "wall-clock ms (overrides)" })),
	thinking: Type.Optional(Type.String({ description: "thinking (overrides)" })),
});

export const taskParameters = Type.Object({
	agent: Type.Optional(Type.String({ description: "definition name" })),
	instructions: Type.Optional(Type.String({ description: "persona (default generic worker)" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "built-ins + host extensions; a list narrows" })),
	model: Type.Optional(Type.String({ description: '"provider/id" (default: inherit)' })),
	task: Type.Optional(Type.String({ description: "self-contained task" })),
	tasks: Type.Optional(
		Type.Array(taskEntryParameters, { description: "concurrent; submission order" }),
	),
	chain: Type.Optional(
		Type.Array(taskEntryParameters, { description: "ordered; {previous} = prior reply" }),
	),
	maxTurns: Type.Optional(Type.Number({ description: "turn cap (overrides)" })),
	maxTokens: Type.Optional(Type.Number({ description: "token cap (overrides)" })),
	timeoutMs: Type.Optional(Type.Number({ description: "wall-clock ms (overrides)" })),
	thinking: Type.Optional(Type.String({ description: `thinking: ${THINKING_LEVELS.join("|")}; overrides` })),
});

export interface DispatchShape {
	kind: "single" | "parallel" | "chain";
	single?: DispatchTask;
	tasks?: DispatchTask[];
	chain?: DispatchTask[];
}

/** Exactly one dispatch shape per call, restated in the error when that is violated. */
export type EntryParams = {
	agent?: string;
	instructions?: string;
	tools?: string[];
	model?: string;
	task?: string;
	maxTurns?: number;
	maxTokens?: number;
	timeoutMs?: number;
	thinking?: string;
};

export function dispatchShape(params: EntryParams & { tasks?: EntryParams[]; chain?: EntryParams[] }): DispatchShape {
	const hasTasks = Array.isArray(params.tasks) && params.tasks.length > 0;
	const hasChain = Array.isArray(params.chain) && params.chain.length > 0;
	const hasSingle =
		params.agent !== undefined || params.task !== undefined || params.instructions !== undefined;
	const usage =
		'Provide exactly one dispatch shape: { agent, task } for one delegation, { tasks: [...] } to fan out, or { chain: [...] } to run steps in order. Inline instructions may replace an agent name.';
	if (Number(hasSingle) + Number(hasTasks) + Number(hasChain) > 1) throw new Error(usage);
	if (hasChain) {
		return { kind: "chain", chain: params.chain!.map(dispatchEntry) };
	}
	if (hasTasks) {
		return { kind: "parallel", tasks: params.tasks!.map(dispatchEntry) };
	}
	if (!hasSingle) throw new Error(usage);
	if (!params.task) {
		throw new Error(`A delegation needs a "task". ${usage}`);
	}
	return { kind: "single", single: dispatchEntry(params) };
}

/** Validate one entry and project it into a dispatch task. */
export function dispatchEntry(entry: EntryParams): DispatchTask {
	if (!entry.task || entry.task.trim() === "") {
		throw new Error('Each entry needs a non-empty "task".');
	}
	const target = delegationTarget(entry);
	return {
		...(target.agentName ? { agent: target.agentName } : {}),
		...(target.adHoc ? { instructions: target.adHoc.instructions, tools: target.adHoc.tools, model: target.adHoc.model } : {}),
		task: entry.task,
		limits: parseLimits(entry),
	};
}

/** Settings-backed default budgets; 0 in settings means "no cap". */
export function budgetDefaults(settings: SubagentSettings) {
	return {
		...(settings.defaultMaxTurns > 0 ? { maxTurns: settings.defaultMaxTurns } : {}),
		...(settings.defaultTimeoutMs > 0 ? { timeoutMs: settings.defaultTimeoutMs } : {}),
	};
}

export function stepDetails(outcomes: readonly TaskOutcome[]) {
	return outcomes.map((outcome) => ({
		index: outcome.index,
		agent: outcome.agent,
		task: outcome.task,
		status: outcome.status,
		...(outcome.details ? { details: outcome.details } : {}),
		...(outcome.error ? { error: outcome.error } : {}),
	}));
}
