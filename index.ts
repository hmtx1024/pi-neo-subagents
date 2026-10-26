/**
 * pi-neo-subagents — subagent delegation for Pi.
 *
 * Loads as a standard Pi extension (jiti, no build step).
 *
 * Surfaces:
 *   - `task` tool: the main agent delegates self-contained tasks to named
 *     subagents that run in isolated nested sessions.
 *   - `/subagents` command: list definitions, inspect one, or run one directly
 *     (`/subagents run <name> [--to-context] <task>`).
 */

import { Type } from "@earendil-works/pi-ai";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	defineTool,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
	createAgentDefinition,
	discoverAgents,
	parseAgentText,
	THINKING_LEVELS,
	type AgentDefinition,
	type DefinitionThinking,
} from "./src/agents.ts";
import {
	delegationTarget,
	delegateTask,
	identityOf,
	resolveModel,
	writeFullResult,
	type DelegationLimits,
	type DelegationOutcome,
	type TaskDetails,
} from "./src/delegate.ts";
import { formatLedger, RunLedger, type LedgerStatus } from "./src/ledger.ts";
import { readSubagentSettings, type SubagentSettings } from "./src/settings.ts";
import {
	dispatchChain,
	dispatchParallel,
	totalUsage,
	type DispatchTask,
	type TaskOutcome,
} from "./src/dispatch.ts";

/** Widget key for the live delegation view (TUI only). */
const LIVE_WIDGET_KEY = "subagents";

/** Locale-independent timestamp for listings. */
function formatTimestamp(ms: number): string {
	return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/** Characters of a direct-run result shown inline; the rest goes to a file. */
const DISPLAY_LIMIT = 2_000;

/**
 * Deliver command output to the user in every mode. In print mode stdout is the
 * answer channel; in JSON mode stdout carries the protocol stream, so plain text
 * goes to stderr instead of corrupting it.
 */
function present(
	ctx: ExtensionCommandContext,
	text: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(text, level);
		return;
	}
	const stream = level === "info" && ctx.mode === "print" ? process.stdout : process.stderr;
	stream.write(`${text}\n`);
}

/** Direct-run result plus a one-line usage summary, capped for readability. */
function formatDirectRun(name: string, outcome: DelegationOutcome): string {
	const { usage, details } = outcome;
	const turns = `${details.turns} turn${details.turns === 1 ? "" : "s"}`;
	const footer = `[${name} · ${details.model} · ${turns} · tokens ${usage.totalTokens} (in ${usage.input} / out ${usage.output}) · $${usage.cost.total.toFixed(6)}]`;
	if (outcome.resultText.length <= DISPLAY_LIMIT) {
		return `${outcome.resultText}\n\n${footer}`;
	}
	const path = outcome.fullResultPath ?? writeFullResult(outcome.reply);
	return `${outcome.resultText.slice(0, DISPLAY_LIMIT)}\n\n[Display truncated at ${DISPLAY_LIMIT} characters. Full result: ${path}]\n\n${footer}`;
}

/** Tools a subagent never receives, even when a whitelist names them. */
const BRIDGE_WITHHELD = new Set(["task", "create_subagent"]);

/** Minimal shape of a callable host tool (ctx.tools / getCallableTools()). */
interface CallableTool {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: never,
		signal?: AbortSignal,
		onUpdate?: (result: never) => void,
	) => Promise<unknown>;
}

/**
 * Bridge wrappers for host EXTENSION tools (built-ins are already available
 * natively in the subagent; MCP and other external tools are not). The wrapper
 * forwards to the host tool itself, whose execution carries the host session's
 * own context — UI dialogs and permission behaviour included. The whitelist
 * filter happens at the delegation layer, per definition.
 */
function buildBridges(ctx: unknown, pi: ExtensionAPI): ToolDefinition[] {
	const source = ctx as { tools?: readonly unknown[]; getCallableTools?: () => readonly unknown[] };
	const tools = (source.tools ?? source.getCallableTools?.() ?? []) as readonly CallableTool[];
	const builtin = new Set(
		pi.getAllTools().filter((info) => info.sourceInfo?.source === "builtin").map((info) => info.name),
	);
	return tools
		.filter((tool) => !BRIDGE_WITHHELD.has(tool.name) && !builtin.has(tool.name))
		.map((tool) => ({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters as ToolDefinition["parameters"],
			execute: (toolCallId: string, params: never, signal?: AbortSignal, onUpdate?: (result: never) => void) =>
				tool.execute(toolCallId, params, signal, onUpdate),
		})) as ToolDefinition[];
}

function buildTaskDescription(agents: AgentDefinition[], cwd: string, agentDir: string): string {
	const projectDir = join(cwd, ".pi", "agents");
	const userDir = join(agentDir, "agents");
	const lines = [
		"Delegate work to named subagents. Write self-contained task descriptions: a subagent sees nothing else.",
		"An entry can be just { task } (generic worker); instructions, tools, model optional — no definition file created.",
		"Shapes: { agent, task } · { tasks: [...] } concurrent (submission order) · { chain: [...] } ordered ({previous} = prior reply).",
		'Host extension tools (search etc.) reach subagents by default; "tools" narrows.',
		`Definitions: ${projectDir} overrides ${userDir}.`,
	];
	if (agents.length === 0) {
		lines.push("No agent definitions found. Create one with create_subagent.");
	} else {
		lines.push("", "Available agents:");
		for (const agent of agents) {
			lines.push(`- ${agent.name}: ${agent.description}`);
		}
		lines.push("", "No match? Create one with create_subagent, then delegate.");
	}
	return lines.join("\n");
}

const taskEntryParameters = Type.Object({
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

const taskParameters = Type.Object({
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

interface DispatchShape {
	kind: "single" | "parallel" | "chain";
	single?: DispatchTask;
	tasks?: DispatchTask[];
	chain?: DispatchTask[];
}

/** Budget overrides must be positive integers; a bad value is a tool-parameter error. */
function positiveInteger(name: string, value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer (got ${value}).`);
	}
	return value;
}

function limitsFrom(params: {
	maxTurns?: number;
	maxTokens?: number;
	timeoutMs?: number;
	thinking?: string;
}): DelegationLimits {
	return {
		maxTurns: positiveInteger("maxTurns", params.maxTurns),
		maxTokens: positiveInteger("maxTokens", params.maxTokens),
		timeoutMs: positiveInteger("timeoutMs", params.timeoutMs),
		thinking: thinkingOverride(params.thinking),
	};
}

/** Exactly one dispatch shape per call, restated in the error when that is violated. */
type EntryParams = {
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

function dispatchShape(params: EntryParams & { tasks?: EntryParams[]; chain?: EntryParams[] }): DispatchShape {
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
function dispatchEntry(entry: EntryParams): DispatchTask {
	if (!entry.task || entry.task.trim() === "") {
		throw new Error('Each entry needs a non-empty "task".');
	}
	const target = delegationTarget(entry);
	return {
		...(target.agentName ? { agent: target.agentName } : {}),
		...(target.adHoc ? { instructions: target.adHoc.instructions, tools: target.adHoc.tools, model: target.adHoc.model } : {}),
		task: entry.task,
		limits: limitsFrom(entry),
	};
}

/** One task per block, in submission order, with its own status. */
function formatOutcomes(outcomes: readonly TaskOutcome[]): string {
	return outcomes
		.map((outcome) => {
			const total = outcomes.length;
			const label =
				outcome.status === "ok"
					? "ok"
					: outcome.status === "budget-stop"
						? `budget stop (${outcome.details?.budgetStop?.kind ?? "budget"})`
						: outcome.status === "skipped"
							? "skipped (an earlier step did not complete)"
							: "failed";
			const body = outcome.status === "failed" ? (outcome.error ?? "failed") : (outcome.resultText ?? "");
			return `[${outcome.index + 1}/${total}] ${outcome.agent} — ${label}\n${body}`;
		})
		.join("\n\n");
}

/** Details entry for one chain step (includes skipped steps). */
/** Settings-backed default budgets; 0 in settings means "no cap". */
function budgetDefaults(settings: SubagentSettings) {
	return {
		...(settings.defaultMaxTurns > 0 ? { maxTurns: settings.defaultMaxTurns } : {}),
		...(settings.defaultTimeoutMs > 0 ? { timeoutMs: settings.defaultTimeoutMs } : {}),
	};
}

function stepDetails(outcomes: readonly TaskOutcome[]) {
	return outcomes.map((outcome) => ({
		index: outcome.index,
		agent: outcome.agent,
		task: outcome.task,
		status: outcome.status,
		...(outcome.details ? { details: outcome.details } : {}),
		...(outcome.error ? { error: outcome.error } : {}),
	}));
}

function thinkingOverride(value: string | undefined): DefinitionThinking | undefined {
	if (value === undefined) return undefined;
	if (!(THINKING_LEVELS as readonly string[]).includes(value)) {
		throw new Error(`thinking must be one of: ${THINKING_LEVELS.join(", ")} (got "${value}").`);
	}
	return value as DefinitionThinking;
}

const createSubagentParameters = Type.Object({
	name: Type.String({ description: "e.g. python-dev" }),
	description: Type.String({ description: "when to delegate" }),
	instructions: Type.String({ description: "markdown body" }),
	tools: Type.Optional(Type.Array(Type.String(), { description: "built-ins + host extensions; a list narrows" })),
	model: Type.Optional(Type.String({ description: "provider/id" })),
	maxTurns: Type.Optional(Type.Number({ description: "turn cap" })),
	maxTokens: Type.Optional(Type.Number({ description: "token cap" })),
	timeoutMs: Type.Optional(Type.Number({ description: "ms cap" })),
	thinking: Type.Optional(Type.String({ description: "thinking level" })),
	scope: Type.Optional(
		Type.Union([Type.Literal("project"), Type.Literal("user")], {
			description: "write scope",
		}),
	),
	overwrite: Type.Optional(Type.Boolean({ description: "replace same-name" })),
});

interface CreateSubagentDetails {
	name: string;
	path: string;
	scope: "project" | "user";
}

/**
 * `create_subagent` — the model-facing way to add a definition. It owns the
 * location (project by default) and the file format, and validates before
 * writing, so a zero-definition session is never a dead end.
 */
function createCreateSubagentTool(getSettings: () => SubagentSettings) {
	return defineTool<typeof createSubagentParameters, CreateSubagentDetails>({
		name: "create_subagent",
		label: "Create subagent",
		description: [
			"Create a named subagent definition (Markdown + frontmatter) for the task tool.",
			'Project scope by default (travels with the repo); scope: "user" for the user directory.',
			"Existing definitions are replaced only with overwrite: true.",
		].join(" "),
		parameters: createSubagentParameters,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const settings = getSettings();
			if (!settings.allowModelCreatedDefinitions) {
				throw new Error(
					"Creating definitions is disabled in this session (subagents.allowModelCreatedDefinitions is false). Ask the user to create the definition instead.",
				);
			}
			if (params.scope === "user" && !settings.allowUserScopeCreation) {
				throw new Error(
					'User-scope creation is disabled (subagents.allowUserScopeCreation is false); use project scope, or ask the user to enable it.',
				);
			}
			// Creation validates against what this session can actually offer, so a
			// typo or an impossible model is caught now instead of at first delegation.
			const result = createAgentDefinition({
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				name: params.name,
				description: params.description,
				instructions: params.instructions,
				tools: params.tools,
				model: params.model,
				maxTurns: params.maxTurns,
				maxTokens: params.maxTokens,
				timeoutMs: params.timeoutMs,
				thinking: params.thinking as DefinitionThinking | undefined,
				scope: params.scope,
				overwrite: params.overwrite,
				validation: {
					availableTools: ctx.tools.map((tool) => tool.name),
					modelExists: (spec) => resolveModel(ctx.modelRegistry.getAll(), spec) !== undefined,
				},
			});
			if (!result.ok) {
				throw new Error(result.error);
			}
			const summary = [
				`Created agent definition "${params.name}" at ${result.path} (${result.scope} scope).`,
				`It is available immediately: task(agent: "${params.name}", task: "...").`,
			];
			if (result.shadowedUser) {
				summary.push(
					`Note: a user-level definition named "${params.name}" exists; this project definition takes precedence.`,
				);
			}
			return {
				content: [{ type: "text", text: summary.join("\n") }],
				details: { name: params.name, path: result.path, scope: result.scope },
			};
		},
	});
}

interface ChainDetails {
	steps: ReturnType<typeof stepDetails>;
}

interface ParallelDetails {
	tasks: Array<{
		index: number;
		agent: string;
		task: string;
		status: string;
		details?: TaskDetails;
		error?: string;
	}>;
}

/**
 * Consent for project-level agents: repository-controlled prompts can instruct a
 * model to run commands, so their first use in a session asks. Answers are
 * remembered per agent for the session; ad-hoc and user-level agents never ask.
 */
async function authorizeAgents(
	entries: readonly DispatchTask[],
	ctx: { cwd: string; hasUI: boolean; ui: { confirm(title: string, message?: string): Promise<boolean> } },
	settings: SubagentSettings,
	approvals: Map<string, boolean>,
): Promise<void> {
	if (settings.confirmProjectAgents === "allow") return;
	const named = [...new Set(entries.map((entry) => entry.agent).filter((name): name is string => Boolean(name)))];
	if (named.length === 0) return;

	const { agents, projectAgentsDir } = discoverAgents(ctx.cwd, getAgentDir());
	for (const name of named) {
		const agent = agents.find((candidate) => candidate.name === name);
		if (!agent || agent.source !== "project") continue;

		const remembered = approvals.get(name);
		if (remembered === false) {
			throw new Error(`Delegation to project agent "${name}" was denied earlier in this session.`);
		}
		if (remembered === true) continue;

		if (!ctx.hasUI) {
			if (settings.confirmProjectAgents === "deny") {
				throw new Error(
					`Project agent "${name}" needs confirmation, but this session has no UI. Set subagents.confirmProjectAgents to "allow" to permit it.`,
				);
			}
			approvals.set(name, true);
			continue;
		}

		const confirmed = await ctx.ui.confirm(
			"Use project-level agent?",
			`"${name}" comes from ${join(projectAgentsDir, agent.file)} and can instruct the model to run commands.`,
		);
		approvals.set(name, confirmed);
		if (!confirmed) {
			throw new Error(`Delegation to project agent "${name}" was denied.`);
		}
	}
}

function createTaskTool(
	description: string,
	recordRun: (record: { agent: string; status: LedgerStatus; details: TaskDetails }) => void,
	getSettings: () => SubagentSettings,
	approvals: Map<string, boolean>,
	pi: ExtensionAPI,
) {
	return defineTool<typeof taskParameters, TaskDetails | ParallelDetails | ChainDetails>({
		name: "task",
		label: "Task",
		description,
		parameters: taskParameters,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const shape = dispatchShape(params);
			// Host extension tools available for this call's whitelists to name.
			const bridges = buildBridges(ctx, pi);
			// Live view state: one line per in-flight delegation, TUI only.
			const live = new Map<string, { agent: string; turn: number; tool?: string }>();
			const renderLive = () => {
				if (ctx.mode !== "tui") return;
				if (live.size === 0) {
					ctx.ui.setWidget(LIVE_WIDGET_KEY, undefined);
					return;
				}
				ctx.ui.setWidget(
					LIVE_WIDGET_KEY,
					[...live.entries()]
						.sort(([left], [right]) => left.localeCompare(right))
						.map(([, entry]) => `${entry.agent} · turn ${entry.turn}${entry.tool ? ` · ${entry.tool}` : ""}`),
				);
			};
			const track = {
				onProgress: (key: string) => (agent: string) => (details: TaskDetails) => {
					live.set(key, { ...(live.get(key) ?? { agent, turn: 0 }), agent, turn: details.turns });
					renderLive();
				},
				onActivity: (key: string) => (agent: string) => (activity: { turn: number; tool: string }) => {
					live.set(key, { ...(live.get(key) ?? { agent, turn: 0 }), agent, tool: activity.tool });
					renderLive();
				},
				settle: (key: string) => () => {
					live.delete(key);
					renderLive();
				},
			};
			await authorizeAgents(
				shape.kind === "single" ? [shape.single!] : (shape.tasks ?? shape.chain ?? []),
				ctx,
				getSettings(),
				approvals,
			);

			if (shape.kind === "chain") {
				const steps = shape.chain ?? [];
				const outcomes = await dispatchChain({
					cwd: ctx.cwd,
					registry: ctx.modelRegistry,
					hostModel: ctx.model,
					steps,
					signal,
					onRun: recordRun,
					maxDepth: getSettings().maxDepth,
					bridges,
					defaults: budgetDefaults(getSettings()),
					onProgress: (index, agent, details) => {
						track.onProgress(String(index))(agent)(details);
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `Step ${index + 1}/${steps.length} (${agent}) · turn ${details.turns}`,
								},
							],
							details,
						});
					},
					onActivity: (index, agent, activity) => track.onActivity(String(index))(agent)(activity),
					onSettled: (index) => track.settle(String(index))(),
				});
				live.clear();
				renderLive();
				const text = formatOutcomes(outcomes);
				// Nothing produced a reply at all: keep the error surface. A later failure
				// or a budget stop still returns a normal result, with every step's status
				// spelled out (cut-short work is not a failure).
				if (outcomes[0] && outcomes[0].status === "failed") {
					throw new Error(text);
				}
				return {
					content: [{ type: "text", text }],
					usage: totalUsage(outcomes),
					details: { steps: stepDetails(outcomes) },
				};
			}

			if (shape.kind === "parallel") {
				const tasks = shape.tasks ?? [];
				// Show every submitted task from the moment it is in flight.
				for (const [index, task] of tasks.entries()) {
					live.set(String(index), { agent: identityOf(task), turn: 0 });
				}
				renderLive();
				const outcomes = await dispatchParallel({
					cwd: ctx.cwd,
					registry: ctx.modelRegistry,
					hostModel: ctx.model,
					tasks,
					signal,
					onRun: recordRun,
					maxDepth: getSettings().maxDepth,
					bridges,
					defaults: budgetDefaults(getSettings()),
					onProgress: (index, agent, details) => {
						track.onProgress(String(index))(agent)(details);
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `Task ${index + 1}/${tasks.length} (${agent}) · turn ${details.turns}`,
								},
							],
							details,
						});
					},
					onActivity: (index, agent, activity) => track.onActivity(String(index))(agent)(activity),
					onSettled: (index) => track.settle(String(index))(),
				});
				live.clear();
				renderLive();
				const text = formatOutcomes(outcomes);
				if (outcomes.every((outcome) => outcome.status === "failed")) {
					throw new Error(text);
				}
				return {
					content: [{ type: "text", text }],
					usage: totalUsage(outcomes),
					details: {
						tasks: outcomes.map((outcome) => ({
							index: outcome.index,
							agent: outcome.agent,
							task: outcome.task,
							status: outcome.status,
							...(outcome.details ? { details: outcome.details } : {}),
							...(outcome.error ? { error: outcome.error } : {}),
						})),
					},
				};
			}

			const single = shape.single!;
			live.set("0", { agent: identityOf(single), turn: 0 });
			renderLive();
			const outcome = await delegateTask({
				cwd: ctx.cwd,
				registry: ctx.modelRegistry,
				hostModel: ctx.model,
				...delegationTarget(single),
				task: single.task,
				limits: single.limits,
				signal,
				maxDepth: getSettings().maxDepth,
				defaults: budgetDefaults(getSettings()),
				bridges,
				onRun: recordRun,
				onActivity: (activity) => track.onActivity("0")(identityOf(single))(activity),
				onProgress: (details) => {
					track.onProgress("0")(identityOf(single))(details);
					onUpdate?.({
						content: [{ type: "text", text: `Subagent running (turn ${details.turns})…` }],
						details,
					});
				},
			});
			track.settle("0")();
			return {
				content: [{ type: "text", text: outcome.resultText }],
				usage: outcome.usage,
				details: outcome.details,
			};
		},
	});
}

const RUN_USAGE = "Usage: /subagents run <name> [--to-context] <task>";

interface RunArguments {
	name: string;
	task: string;
	toContext: boolean;
}

/**
 * Parse `/subagents run` arguments strictly: options only before the name, a
 * `--` terminator, and quoted names. The task text is never rewritten.
 */
function parseRunArguments(raw: string):
	| { ok: true; args: RunArguments }
	| { ok: false; error: string } {
	let rest = raw.trim();
	let toContext = false;

	while (rest.startsWith("--")) {
		const end = rest.search(/\s/);
		const token = end === -1 ? rest : rest.slice(0, end);
		if (token === "--") {
			rest = end === -1 ? "" : rest.slice(end).trim();
			break;
		}
		if (token !== "--to-context") {
			return { ok: false, error: `Unknown option "${token}". ${RUN_USAGE}` };
		}
		toContext = true;
		rest = end === -1 ? "" : rest.slice(end).trim();
	}

	let name: string;
	if (rest.startsWith('"')) {
		const closing = rest.indexOf('"', 1);
		if (closing === -1) {
			return { ok: false, error: `Unterminated quoted agent name. ${RUN_USAGE}` };
		}
		name = rest.slice(1, closing);
		rest = rest.slice(closing + 1).trim();
	} else {
		const end = rest.search(/\s/);
		name = end === -1 ? rest : rest.slice(0, end);
		rest = end === -1 ? "" : rest.slice(end).trim();
	}

	const task = rest.trim();
	if (!name || !task) {
		return { ok: false, error: RUN_USAGE };
	}
	return { ok: true, args: { name, task, toContext } };
}


/** Absolute path of a definition, using the directory discovery resolved. */
function definitionPath(agent: AgentDefinition, projectAgentsDir: string, agentDir: string): string {
	return agent.source === "project"
		? join(projectAgentsDir, agent.file)
		: join(agentDir, "agents", agent.file);
}

/** Find one definition by name, or report what does exist. */
function findDefinition(ctx: ExtensionCommandContext, name: string) {
	const discovery = discoverAgents(ctx.cwd, getAgentDir());
	const agent = discovery.agents.find((candidate) => candidate.name === name);
	if (!agent) {
		const available = discovery.agents.map((candidate) => candidate.name).join(", ");
		present(ctx, `No agent definition named "${name}". Available: ${available}.`, "error");
		return undefined;
	}
	return { agent, discovery };
}

/** `/subagents new [<name>] [description...] [--force]` — scaffold a definition. */
async function handleNew(rest: string, ctx: ExtensionCommandContext): Promise<void> {
	const tokens = rest.split(/\s+/).filter(Boolean);
	const force = tokens.includes("--force");
	const positional = tokens.filter((token) => token !== "--force");
	let name = positional.shift() ?? "";
	let description = positional.join(" ").trim();

	if (ctx.hasUI) {
		if (name === "") {
			name = ((await ctx.ui.input("Agent name", "e.g. reviewer")) ?? "").trim();
		}
		if (name !== "" && description === "") {
			description = (
				(await ctx.ui.input("Description", "when the main agent should delegate to this agent")) ?? ""
			).trim();
		}
	}

	if (name === "" || description === "") {
		present(
			ctx,
			"Usage: /subagents new <name> [description] [--force]. Name and description are required.",
			"error",
		);
		return;
	}

	const result = createAgentDefinition({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		projectAgentsDir: discoverAgents(ctx.cwd, getAgentDir()).projectAgentsDir,
		name,
		description,
		instructions: `You are the ${name} agent. ${description}`,
		overwrite: force,
		validation: {
			modelExists: (spec) => resolveModel(ctx.modelRegistry.getAll(), spec) !== undefined,
		},
	});
	if (!result.ok) {
		present(ctx, result.error, "error");
		return;
	}
	present(ctx, `Created ${result.path}. Add instructions with /subagents edit ${name}.`);
}

/** `/subagents edit <name>` — open the resolved file and save valid edits only. */
async function handleEdit(rest: string, ctx: ExtensionCommandContext): Promise<void> {
	const name = rest.trim();
	if (name === "") {
		present(ctx, "Usage: /subagents edit <name>", "error");
		return;
	}
	const found = findDefinition(ctx, name);
	if (!found) return;
	if (!ctx.hasUI) {
		present(ctx, "Editing needs an interactive terminal (or edit the file directly).", "error");
		return;
	}
	const path = definitionPath(found.agent, found.discovery.projectAgentsDir, getAgentDir());
	const edited = await ctx.ui.editor(`Edit ${found.agent.file}`, readFileSync(path, "utf-8"));
	if (edited === undefined) {
		present(ctx, "Edit cancelled.");
		return;
	}
	const parsed = parseAgentText(edited, found.agent.file, found.agent.source);
	if (!parsed.ok) {
		present(ctx, `Not saved: ${parsed.error.message}`, "error");
		return;
	}
	writeFileSync(path, edited, "utf-8");
	present(ctx, `Saved ${path}.`);
}

/** `/subagents rm <name> [--yes]` — delete one definition after confirmation. */
async function handleRemove(rest: string, ctx: ExtensionCommandContext): Promise<void> {
	const tokens = rest.split(/\s+/).filter(Boolean);
	const yes = tokens.includes("--yes");
	const name = tokens.filter((token) => token !== "--yes").join(" ").trim();
	if (name === "") {
		present(ctx, "Usage: /subagents rm <name> [--yes]", "error");
		return;
	}
	const found = findDefinition(ctx, name);
	if (!found) return;
	const path = definitionPath(found.agent, found.discovery.projectAgentsDir, getAgentDir());

	if (!yes) {
		if (!ctx.hasUI) {
			present(ctx, `Refusing to delete ${found.agent.file} without confirmation. Re-run with --yes.`, "error");
			return;
		}
		const confirmed = await ctx.ui.confirm(
			"Delete agent definition?",
			`${found.agent.file} (${found.agent.source})`,
		);
		if (!confirmed) {
			present(ctx, "Delete cancelled.");
			return;
		}
	}
	unlinkSync(path);
	present(ctx, `Deleted ${path}.`);
}

/** `/subagents run <name> [--to-context] <task>` — user-invoked delegation. */
async function handleRun(
	rest: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	getSettings: () => SubagentSettings,
): Promise<void> {
	// Command contexts cannot reach host tools (no tools/executeTool on ctx),
	// so a definition that needs a bridged extension tool fails here loudly
	// with the delegation-layer message instead of silently degrading.
	const parsed = parseRunArguments(rest);
	if (!parsed.ok) {
		present(ctx, parsed.error, "error");
		return;
	}
	const { name, task, toContext } = parsed.args;
	try {
		const outcome = await delegateTask({
			cwd: ctx.cwd,
			registry: ctx.modelRegistry,
			hostModel: ctx.model,
			agentName: name,
			task,
			signal: ctx.signal,
			defaults: budgetDefaults(getSettings()),
			onProgress: (details) => ctx.ui.setStatus("subagents", `${name} · turn ${details.turns}`),
		});
		present(ctx, formatDirectRun(name, outcome));
		if (toContext) {
			pi.sendUserMessage(`Subagent "${name}" completed task "${task}":\n\n${outcome.resultText}`);
		}
	} catch (error) {
		present(ctx, error instanceof Error ? error.message : String(error), "error");
	} finally {
		ctx.ui.setStatus("subagents", undefined);
	}
}

export default function (pi: ExtensionAPI) {
	let currentCwd = process.cwd();
	let inventorySignature = "";
	const ledger = new RunLedger();
	const approvals = new Map<string, boolean>();
	/** Effective settings, read fresh so a settings change applies without a reload. */
	const getSettings = (): SubagentSettings => {
		try {
			const all = pi.getSettings() as unknown as Record<string, unknown>;
			return readSubagentSettings(all?.subagents);
		} catch {
			return readSubagentSettings(undefined);
		}
	};

	/** Account for one delegation (any depth); failures and budget stops are counted apart. */
	const recordRun = (record: { agent: string; status: LedgerStatus; details: TaskDetails }) => {
		ledger.record({
			agent: record.agent,
			status: record.status,
			turns: record.details.turns,
			usage: record.details.usage,
			durationMs: record.details.durationMs,
			depth: record.details.depth,
		});
	};

	// Re-registering the tool replaces it and records the tool change before the
	// next model request, so the description always reflects current definitions.
	const refreshTaskTool = () => {
		const { agents } = discoverAgents(currentCwd, getAgentDir());
		const description = buildTaskDescription(agents, currentCwd, getAgentDir());
		if (description === inventorySignature) {
			return;
		}
		inventorySignature = description;
		pi.registerTool(createTaskTool(description, recordRun, getSettings, approvals, pi));
	};

	pi.registerTool(createCreateSubagentTool(getSettings));
	refreshTaskTool();
	pi.on("session_start", (_event, ctx) => {
		currentCwd = ctx.cwd;
		ledger.reset();
		approvals.clear();
		refreshTaskTool();
	});
	pi.on("before_agent_start", (_event, ctx) => {
		currentCwd = ctx.cwd;
		refreshTaskTool();
	});

	pi.registerCommand("subagents", {
		description: "List and inspect subagent definitions; run one directly",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "run" || trimmed.startsWith("run ")) {
				await handleRun(trimmed.slice("run".length).trim(), ctx, pi, getSettings);
				return;
			}
			if (trimmed === "new" || trimmed.startsWith("new ")) {
				await handleNew(trimmed.slice("new".length).trim(), ctx);
				return;
			}
			if (trimmed === "edit" || trimmed.startsWith("edit ")) {
				await handleEdit(trimmed.slice("edit".length).trim(), ctx);
				return;
			}
			if (trimmed === "rm" || trimmed.startsWith("rm ")) {
				await handleRemove(trimmed.slice("rm".length).trim(), ctx);
				return;
			}
			if (trimmed === "stats") {
				present(ctx, formatLedger(ledger));
				return;
			}
			if (trimmed === "stats reset") {
				ledger.reset();
				present(ctx, "Delegation ledger reset.");
				return;
			}
			const { agents, errors, projectAgentsDir } = discoverAgents(ctx.cwd, getAgentDir());
			if (errors.length > 0) {
				present(
					ctx,
					errors.map((error) => `${error.file}: ${error.message}`).join("\n"),
					"error",
				);
			}
			const name = trimmed;
			if (name !== "") {
				const agent = agents.find((candidate) => candidate.name === name);
				if (!agent) {
					present(ctx, `No agent definition named "${name}". Available: ${agents.map((candidate) => candidate.name).join(", ")}.`, "error");
					return;
				}
				const tools = agent.tools?.join(", ") ?? "all default";
				const model = agent.model ?? "inherit";
				const origin = agent.overridesUser
					? "project, overrides user definition"
					: agent.source;
				present(
					ctx,
					[
						`Agent: ${agent.name} (${origin})`,
						`File: ${agent.file}${agent.modifiedAt === undefined ? "" : ` · modified ${formatTimestamp(agent.modifiedAt)}`}`,
						`Description: ${agent.description}`,
						`Tools: ${tools}`,
						`Model: ${model}`,
						"",
						agent.body.trim(),
					].join("\n"),
					"info",
				);
				return;
			}
			if (agents.length === 0) {
				present(ctx, "No agent definitions found.");
				return;
			}
			const lines = [
				"Available agents:",
				...agents.map((agent) => {
					const tools = agent.tools?.join(", ") ?? "all default";
					const model = agent.model ?? "inherit";
					const override = agent.overridesUser ? " [overrides user definition]" : "";
					const origin = `${agent.source}: ${agent.file}${agent.modifiedAt === undefined ? "" : ` · ${formatTimestamp(agent.modifiedAt)}`}`;
					return `- ${agent.name} — ${agent.description} (tools: ${tools} | model: ${model} | ${origin})${override}`;
				}),
			];
			present(ctx, lines.join("\n"));
		},
	});
}
