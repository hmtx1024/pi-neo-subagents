/**
 * Delegation flow shared by the `task` tool and `/subagents run`: agent
 * lookup, model resolution, nested-session execution, and result shaping.
 *
 * Internal module — tests observe it only through the tool and command
 * surfaces.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Model, Provider, Usage } from "@earendil-works/pi-ai";
import { getAgentDir, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import { discoverAgents, type AgentDefinition, type DefinitionThinking } from "./agents.ts";
import { runSubagent, type BudgetStop, type SpawnHandler } from "./runner.ts";

const MAX_RESULT_CHARS = 30_000;

/** Ledger identity for definition-free delegations. */
export const AD_HOC_AGENT_NAME = "ad-hoc";

export interface TaskDetails {
	task: string;
	model: string;
	turns: number;
	usage?: Usage;
	durationMs?: number;
	/** Thinking level applied to the nested session, when one was pinned. */
	thinking?: DefinitionThinking;
	/** Present when a budget stopped the run before it finished. */
	budgetStop?: BudgetStop;
	/** Depth this run executed at (host session = 0). */
	depth: number;
}

/** Definition-free delegation: instructions plus optional capabilities. */
export interface AdHocSpec {
	instructions: string;
	description?: string;
	tools?: string[];
	model?: string;
	limits?: DelegationLimits;
}

/**
 * Normalise a dispatch entry into a delegation target. An entry names either an
 * `agent` or inline `instructions` — or neither, in which case the `task` alone
 * runs with a generic worker persona (the natural input; a real-usage session
 * burned two host rounds learning this the hard way). Both `agent` and
 * `instructions` is a caller error.
 */
const DEFAULT_AD_HOC_INSTRUCTIONS =
	"You are a careful worker. Complete the task exactly as described, verify the outcome, and report it.";

export function delegationTarget(entry: {
	agent?: string;
	instructions?: string;
	task?: string;
	tools?: string[];
	model?: string;
	limits?: DelegationLimits;
}): Pick<DelegationRequest, "agentName" | "adHoc"> {
	const hasAgent = entry.agent !== undefined;
	const hasInstructions = entry.instructions !== undefined;
	if (hasAgent && hasInstructions) {
		throw new Error('An entry needs either an "agent" name or "instructions", not both.');
	}
	if (!hasAgent && !hasInstructions) {
		if (entry.task !== undefined && entry.task.trim() !== "") {
			return {
				adHoc: {
					instructions: DEFAULT_AD_HOC_INSTRUCTIONS,
					...(entry.tools && entry.tools.length > 0 ? { tools: entry.tools } : {}),
					...(entry.model ? { model: entry.model } : {}),
					...(entry.limits ? { limits: entry.limits } : {}),
				},
			};
		}
		throw new Error('Each entry needs a "task"; "agent" and "instructions" are optional.');
	}
	if (hasInstructions) {
		return {
			adHoc: {
				instructions: entry.instructions ?? "",
				...(entry.tools && entry.tools.length > 0 ? { tools: entry.tools } : {}),
				...(entry.model ? { model: entry.model } : {}),
				...(entry.limits ? { limits: entry.limits } : {}),
			},
		};
	}
	return { agentName: entry.agent };
}

/** Identity used in results and the ledger: the agent name, else the ad-hoc label. */
export function identityOf(entry: { agent?: string }): string {
	return entry.agent ?? AD_HOC_AGENT_NAME;
}

/** Settings-backed defaults for delegations that set neither call nor definition values. */
export interface DelegationDefaults {
	maxTurns?: number;
	timeoutMs?: number;
}

/** Per-call budget overrides; each wins over the definition's value. */
export interface DelegationLimits {
	maxTurns?: number;
	timeoutMs?: number;
	maxTokens?: number;
	thinking?: DefinitionThinking;
}

/** The registry surface delegation needs (the session's model registry). */
export interface DelegationRegistry {
	getAll(): readonly Model<any>[];
	getProvider(providerId: string): Provider | undefined;
}

export interface DelegationRequest {
	cwd: string;
	/** The registry to resolve `model` fields and providers against. */
	registry: DelegationRegistry;
	/** The host session's current model (used when the definition pins none). */
	hostModel: Model<any> | undefined;
	/** Named definition to delegate to. Mutually exclusive with `adHoc`. */
	agentName?: string;
	/** Inline, definition-free delegation. */
	adHoc?: AdHocSpec;
	task: string;
	signal?: AbortSignal;
	/** Call-level budget overrides. */
	limits?: DelegationLimits;
	/** Settings-backed defaults (lowest precedence; 0 already normalised away). */
	defaults?: DelegationDefaults;
	/** Host extension tools available to bridge into the nested session. */
	bridges?: ToolDefinition[];
	/** Delegation depth; a top-level delegation is 1. */
	depth?: number;
	/** Depth limit for nested delegations. */
	maxDepth?: number;
	/** Live activity for UI views (tool starts inside the subagent). */
	onActivity?: (activity: { turn: number; tool: string }) => void;
	/** Invoked after every run (including nested ones) so accounting covers all levels. */
	onRun?: (record: { agent: string; status: "ok" | "budget-stop" | "failed"; details: TaskDetails }) => void;
	onProgress?: (details: TaskDetails) => void;
}

export interface DelegationOutcome {
	/** The subagent's full final reply. */
	reply: string;
	/** Model-facing result text: truncated with an on-disk notice when oversized. */
	resultText: string;
	/** Path of the on-disk copy, when the result was oversized. */
	fullResultPath?: string;
	details: TaskDetails;
	usage: Usage;
}

/**
 * Result text as the model sees it: oversized replies are truncated with a
 * notice naming the on-disk copy of the full result (context protection).
 */
function toResultContent(reply: string): { text: string; fullResultPath?: string } {
	if (reply.length <= MAX_RESULT_CHARS) {
		return { text: reply };
	}
	const path = writeFullResult(reply);
	return {
		text: `${reply.slice(0, MAX_RESULT_CHARS)}\n\n[Truncated at ${MAX_RESULT_CHARS} characters. Full result: ${path}]`,
		fullResultPath: path,
	};
}

/** Write a full result to a temp file and return its path. */
export function writeFullResult(text: string): string {
	const path = join(tmpdir(), `pi-neo-subagents-result-${randomUUID()}.txt`);
	writeFileSync(path, text, "utf-8");
	return path;
}

/** Resolve a model spec against the registry: `provider/id` or bare id. */
export function resolveModel(models: readonly Model<any>[], spec: string): Model<any> | undefined {
	return (
		models.find((candidate) => `${candidate.provider}/${candidate.id}` === spec) ??
		models.find((candidate) => candidate.id === spec)
	);
}

interface ResolvedTarget {
	agent: AgentDefinition;
	modelSpec?: string;
	fromAdHoc?: boolean;
}

/**
 * Resolve a delegation target: a named definition (discovered from disk) or an
 * inline ad-hoc spec. Ad-hoc needs no definitions to exist.
 */
function resolveTarget(request: DelegationRequest): ResolvedTarget {
	if (request.agentName !== undefined && request.adHoc !== undefined) {
		throw new Error('Provide either an agent name or inline instructions, not both.');
	}
	if (request.adHoc !== undefined) {
		const spec = request.adHoc;
		if (spec.instructions.trim() === "") {
			throw new Error("Inline instructions must not be empty.");
		}
		return {
			agent: {
				file: AD_HOC_AGENT_NAME,
				name: AD_HOC_AGENT_NAME,
				description: spec.description ?? "Ad-hoc delegation",
				...(spec.tools && spec.tools.length > 0 ? { tools: spec.tools } : {}),
				...(spec.model ? { model: spec.model } : {}),
				...spec.limits,
				body: spec.instructions,
				source: "project",
				overridesUser: false,
			},
			...(spec.model ? { modelSpec: spec.model } : {}),
			fromAdHoc: true,
		};
	}
	if (request.agentName === undefined) {
		throw new Error('Each delegation needs an agent name or inline instructions.');
	}
	const { agents } = discoverAgents(request.cwd, getAgentDir());
	if (agents.length === 0) {
		throw new Error("No agent definitions found.");
	}
	const agent = agents.find((candidate) => candidate.name === request.agentName);
	if (!agent) {
		const available = agents.map((candidate) => candidate.name).join(", ");
		throw new Error(`No agent definition named "${request.agentName}". Available: ${available}.`);
	}
	return { agent, ...(agent.model ? { modelSpec: agent.model } : {}) };
}

/** Run one delegation end to end. Throws with clear, model/user-visible errors. */
export async function delegateTask(request: DelegationRequest): Promise<DelegationOutcome> {
	try {
		const outcome = await runDelegation(request);
		request.onRun?.({
			agent: identityOf({ agent: request.agentName }),
			status: outcome.details.budgetStop ? "budget-stop" : "ok",
			details: outcome.details,
		});
		return outcome;
	} catch (error) {
		// Accounting must never mask the failure: the model a definition pinned is
		// reported when it can be resolved, and the host model is the fallback.
		// (RunLedger does not read this field today; it is kept truthful anyway.)
		request.onRun?.({
			agent: identityOf({ agent: request.agentName }),
			status: "failed",
			details: {
				task: request.task,
				model: pinnedModelId(request) ?? request.hostModel?.id ?? "unknown",
				turns: 0,
				depth: request.depth ?? 1,
			},
		});
		throw error;
	}
}

/** The model a named definition pins, or undefined when it pins none / cannot be read. */
function pinnedModelId(request: DelegationRequest): string | undefined {
	if (request.agentName === undefined || request.adHoc !== undefined) return undefined;
	try {
		const { agents } = discoverAgents(request.cwd, getAgentDir());
		return agents.find((candidate) => candidate.name === request.agentName)?.model;
	} catch {
		return undefined;
	}
}

async function runDelegation(request: DelegationRequest): Promise<DelegationOutcome> {
	const target = resolveTarget(request);
	const { agent } = target;

	const model = target.modelSpec ? resolveModel(request.registry.getAll(), target.modelSpec) : request.hostModel;
	if (target.modelSpec && !model) {
		throw new Error(
			target.fromAdHoc
				? `Ad-hoc delegation: unknown model "${target.modelSpec}".`
				: `Agent definition "${agent.file}": unknown model "${target.modelSpec}".`,
		);
	}
	if (!model) {
		throw new Error("No model available to run the subagent.");
	}
	const provider = request.registry.getProvider(model.provider);
	if (!provider) {
		throw new Error(`No provider available for model "${model.id}".`);
	}

	// Precedence: call > definition > settings default. Defaults are only a
	// safety net: an unset value would mean an unbounded run.
	const limits = {
		maxTurns: request.limits?.maxTurns ?? agent.maxTurns ?? request.defaults?.maxTurns,
		timeoutMs: request.limits?.timeoutMs ?? agent.timeoutMs ?? request.defaults?.timeoutMs,
		maxTokens: request.limits?.maxTokens ?? agent.maxTokens,
		thinking: request.limits?.thinking ?? agent.thinking,
	};

	// Delegation levels: a top-level delegation is 1, its child is 2.
	const depth = request.depth ?? 1;
	const maxDepth = request.maxDepth ?? 1;

	// A definition may opt into spawning; the tool is registered only then, and
	// the handler refuses anything that would exceed the depth limit.
	const spawn: SpawnHandler | undefined =
		agent.allowSubagents === true
			? async (entry) => {
					const childDepth = depth + 1;
					if (childDepth > maxDepth) {
						throw new Error(
							`Delegation depth limit reached: max depth ${maxDepth}, this call would run at depth ${childDepth}.`,
						);
					}
					const child = await delegateTask({
						cwd: request.cwd,
						registry: request.registry,
						hostModel: request.hostModel,
						agentName: entry.agent,
						task: entry.task,
						limits: entry.limits,
						...(request.defaults ? { defaults: request.defaults } : {}),
						...(request.bridges ? { bridges: request.bridges } : {}),
						signal: request.signal,
						depth: childDepth,
						maxDepth,
						...(request.onRun ? { onRun: request.onRun } : {}),
					});
					return { resultText: child.resultText, usage: child.usage, details: child.details };
				}
			: undefined;

	const run = await runSubagent({
		agent,
		task: request.task,
		cwd: request.cwd,
		model,
		provider,
		tools: agent.tools,
		signal: request.signal,
		depth,
		...(spawn ? { spawn } : {}),
		...(request.bridges?.length ? { bridges: request.bridges } : {}),
		...(request.onActivity ? { onActivity: request.onActivity } : {}),
		...limits,
		onProgress: (turns) => {
			request.onProgress?.({
				task: request.task,
				model: model.id,
				turns,
				depth,
				...(limits.thinking ? { thinking: limits.thinking } : {}),
			});
		},
	});
	const content = toResultContent(run.reply);
	const resultText = run.budgetStop
		? `${content.text}

[Budget stop: ${run.budgetStop.kind} limit ${run.budgetStop.limit} reached (observed ${run.budgetStop.observed}). Partial reply above.]`
		: content.text;
	return {
		reply: run.reply,
		resultText,
		...(content.fullResultPath ? { fullResultPath: content.fullResultPath } : {}),
		details: {
			task: request.task,
			model: model.id,
			turns: run.turns,
			usage: run.usage,
			durationMs: run.durationMs,
			depth,
			...(limits.thinking ? { thinking: limits.thinking } : {}),
			...(run.budgetStop ? { budgetStop: run.budgetStop } : {}),
		},
		usage: run.usage,
	};
}
