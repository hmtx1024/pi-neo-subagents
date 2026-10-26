/**
 * Subagent runner: executes one task in a nested, isolated agent session.
 *
 * Internal module — tests observe it only through the `task` tool surface.
 *
 * Isolation contract: the nested session receives only the task text and the
 * agent definition, never host conversation history. No extensions load in the
 * nested session (the `task` tool cannot recurse, and host extensions cannot
 * leak in). The model provider is mirrored from the host so auth and streaming
 * behaviour stay identical.
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	defineTool,
	getAgentDir,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { Model, Provider, ThinkingLevel, Usage } from "@earendil-works/pi-ai";

import { discoverAgents, type AgentDefinition } from "./agents.ts";
import { parseLimits } from "./limits.ts";

/** Which budget stopped a run, and the value that tripped it. */
export type BudgetKind = "turns" | "timeout" | "tokens";

export interface BudgetStop {
	kind: BudgetKind;
	/** The configured limit. */
	limit: number;
	/** The value observed when the limit was reached. */
	observed: number;
}

export interface SubagentRun {
	/** The subagent's final reply. */
	reply: string;
	/** Number of model turns the subagent took. */
	turns: number;
	/** Token usage of the subagent's model calls. */
	usage: Usage;
	/** Wall-clock duration of the run. */
	durationMs: number;
	/** Set when a budget stopped the run before it finished. */
	budgetStop?: BudgetStop;
}

/** What a nested `task` tool may ask for, and what it gets back. */
export interface SpawnRequest {
	agent: string;
	task: string;
	limits?: {
		maxTurns?: number;
		maxTokens?: number;
		timeoutMs?: number;
		thinking?: ThinkingLevel;
	};
}

export interface SpawnResult {
	resultText: string;
	usage: Usage;
	details: unknown;
}

export type SpawnHandler = (request: SpawnRequest) => Promise<SpawnResult>;

export interface RunSubagentOptions {
	agent: AgentDefinition;
	task: string;
	cwd: string;
	model: Model<any>;
	provider: Provider;
	/** Allowed tool names (agent definition whitelist); omitted means all default tools. */
	tools?: string[];
	/** Host extension tools to bridge, when the whitelist names them. */
	bridges?: ToolDefinition[];
	signal?: AbortSignal;
	/** Coarse progress callback: called after each completed subagent turn. */
	onProgress?: (turns: number) => void;
	/** Called when the subagent starts a tool call (for live views). */
	onActivity?: (activity: { turn: number; tool: string }) => void;
	/** Cap on assistant turns; omitted means unbounded. */
	maxTurns?: number;
	/** Cap on wall-clock milliseconds; omitted means unbounded. */
	timeoutMs?: number;
	/** Cap on total tokens; omitted means unbounded. */
	maxTokens?: number;
	/** Thinking level for the nested session; omitted means inherit. */
	thinking?: ThinkingLevel;
	/** Depth this run executes at (the host session is 0). */
	depth?: number;
	/** Present only when the definition opted into spawning subagents. */
	spawn?: SpawnHandler;
}

export async function runSubagent(options: RunSubagentOptions): Promise<SubagentRun> {
	const modelRuntime = await ModelRuntime.create({
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(options.provider);

	// Extension tools cross by default — the host session has them, so does the
	// subagent. A `tools` whitelist narrows the set strictly (naming is then
	// required to keep a given tool). Withheld tools are already excluded at
	// the build site in the extension entry.
	const bridged = !options.bridges?.length
		? []
		: options.tools
			? options.bridges.filter((tool) => options.tools!.includes(tool.name))
			: options.bridges;

	const replacePrompt = options.agent.systemPrompt === "replace";
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		// A subagent sees its task and definition only: no host skill index,
		// prompt templates, themes, or context files leaking into its prompt.
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [createSubagentSessionExtension(options)],
		...(replacePrompt
			? {
					systemPromptOverride: () => options.agent.body,
					appendSystemPromptOverride: () => [],
				}
			: {
					appendSystemPromptOverride: (base) => [...base, options.agent.body],
				}),
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: options.cwd,
		modelRuntime,
		model: options.model,
		sessionManager: SessionManager.inMemory(options.cwd),
		resourceLoader,
		...(options.tools ? { tools: options.tools } : {}),
		...(options.thinking ? { thinkingLevel: options.thinking } : {}),
		...(bridged.length > 0 ? { customTools: bridged } : {}),
	});

	// Fail loud: a whitelist the subagent cannot satisfy is a dead end waiting
	// to happen, so name the missing tools instead of silently dropping them.
	if (options.tools && options.tools.length > 0) {
		const provided = new Set(session.getAllTools().map((tool) => tool.name));
		const missing = options.tools.filter((name) => !provided.has(name));
		if (missing.length > 0) {
			session.dispose();
			throw new Error(
				`The subagent cannot provide these tools: ${missing.join(", ")}. ` +
					`Available here: ${provided.size > 0 ? [...provided].join(", ") : "(none)"}. ` +
					"A host extension tool is available only when the main agent delegates through the " +
					'task tool and the name is listed in "tools"; "task" and "create_subagent" are never available.',
			);
		}
	}

	const startedAt = Date.now();
	let observedTurns = 0;
	let observedTokens = 0;
	let budgetStop: BudgetStop | undefined;
	let replyAtStop: string | undefined;
	let turnsAtStop: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	// A budget only stops a run that would otherwise continue: a turn that ends
	// the conversation is already finished, so reporting a stop would be a lie.
	const stopFor = (next: BudgetStop, message?: unknown) => {
		if (budgetStop) return;
		budgetStop = next;
		// Report the state as of the stop, not whatever a later turn produced.
		turnsAtStop = observedTurns;
		replyAtStop = message === undefined ? undefined : textOf(message);
		session.abort();
	};

	session.subscribe((event) => {
		if (event.type === "turn_end") {
			options.onProgress?.(observedTurns);
			return;
		}
		if (event.type === "tool_execution_start") {
			options.onActivity?.({ turn: observedTurns, tool: event.toolName });
			return;
		}
		if (event.type !== "message_end") return;
		const message = event.message as { role?: string; usage?: Usage; stopReason?: string };
		if (message.role !== "assistant") return;
		observedTurns += 1;
		observedTokens += message.usage?.totalTokens ?? 0;
		if (message.stopReason !== "toolUse") return;
		if (options.maxTurns !== undefined && observedTurns >= options.maxTurns) {
			stopFor({ kind: "turns", limit: options.maxTurns, observed: observedTurns }, message);
		} else if (options.maxTokens !== undefined && observedTokens >= options.maxTokens) {
			stopFor({ kind: "tokens", limit: options.maxTokens, observed: observedTokens }, message);
		}
	});

	if (options.timeoutMs !== undefined) {
		const timeoutMs = options.timeoutMs;
		timer = setTimeout(() => {
			stopFor({ kind: "timeout", limit: timeoutMs, observed: Date.now() - startedAt });
		}, timeoutMs);
		timer.unref?.();
	}
	try {
		if (options.signal) {
			if (options.signal.aborted) {
				throw new Error("Task was cancelled.");
			}
			options.signal.addEventListener("abort", () => session.abort(), { once: true });
		}
		await session.prompt(options.task);
		if (options.signal?.aborted) {
			throw new Error("Task was cancelled.");
		}
		const assistantMessages = session.messages.filter((message) => message.role === "assistant");
		const reply = budgetStop
			? (replyAtStop ?? lastText(assistantMessages))
			: (session.getLastAssistantText() ?? lastText(assistantMessages));
		if (reply === undefined && !budgetStop) {
			throw new Error("The subagent produced no reply.");
		}
		return {
			reply: reply ?? "",
			turns: budgetStop ? (turnsAtStop ?? observedTurns) : observedTurns,
			usage: sumUsage(assistantMessages),
			durationMs: Date.now() - startedAt,
			...(budgetStop ? { budgetStop } : {}),
		};
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		session.dispose();
	}
}

/** Concatenated text blocks of one message, trimmed. */
function textOf(message: unknown): string | undefined {
	const content = (message as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
	const text = content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("")
		.trim();
	return text === "" ? undefined : text;
}

/** Last non-empty assistant text in the transcript (used when a budget cuts a turn short). */
function lastText(messages: Array<{ content?: Array<{ type: string; text?: string }> }>): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const text = (messages[index].content ?? [])
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("")
			.trim();
		if (text !== "") return text;
	}
	return undefined;
}

/** Sum several usage records (used for fan-out results). */
export function combineUsage(usages: readonly Usage[]): Usage {
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const usage of usages) {
		if (!usage) continue;
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.totalTokens += usage.totalTokens;
		total.cost.input += usage.cost.input;
		total.cost.output += usage.cost.output;
		total.cost.cacheRead += usage.cost.cacheRead;
		total.cost.cacheWrite += usage.cost.cacheWrite;
		total.cost.total += usage.cost.total;
	}
	return total;
}

function sumUsage(messages: Array<{ usage?: Usage }>): Usage {
	return combineUsage(messages.map((message) => message.usage).filter((usage): usage is Usage => usage !== undefined));
}

/**
 * The nested `task` tool: registered only for definitions that opted into
 * spawning, so recursion is impossible without an explicit declaration. The
 * depth limit is enforced by the handler the delegation layer supplied.
 */
/**
 * The inline extension every nested session loads. Two jobs:
 * - drop Pi's `docs` pointer from the system prompt — a subagent is never asked
 *   about pi itself, and the section costs 343 tokens per request. Inline
 *   extensions still get event handlers although discovered extensions are off.
 * - register the nested `task` tool, only for definitions that opted into
 *   spawning, so recursion stays structurally impossible otherwise.
 */
function createSubagentSessionExtension(options: RunSubagentOptions) {
	return {
		name: "pi-neo-subagents/session",
		factory: (pi: ExtensionAPI) => {
			pi.on("context_with_system", (event) => {
				const [first, ...rest] = event.messages;
				if (first?.role !== "system" || !first.sections?.docs) return undefined;
				const sections = { ...first.sections };
				delete sections.docs;
				return { messages: [{ ...first, sections }, ...rest] };
			});
			if (!options.spawn) return;
			const spawn = options.spawn;
			const available = discoverAgents(options.cwd, getAgentDir()).agents;
			const enumeration =
				available.length === 0
					? "No agent definitions found."
					: `Available agents:\n${available.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n")}`;
			pi.registerTool(
				defineTool({
					name: "task",
					label: "Task",
					description: [
						"Delegate a task to a named subagent. Write a self-contained task description: the subagent sees nothing else.",
						enumeration,
					].join("\n\n"),
					parameters: Type.Object({
						agent: Type.String({ description: "Name of the agent definition to delegate to" }),
						task: Type.String({ description: "Self-contained task description" }),
						maxTurns: Type.Optional(Type.Number({ description: "Cap on assistant turns" })),
						maxTokens: Type.Optional(Type.Number({ description: "Cap on total tokens" })),
						timeoutMs: Type.Optional(Type.Number({ description: "Wall-clock cap in milliseconds" })),
						thinking: Type.Optional(Type.String({ description: "Thinking level" })),
					}),
					async execute(
						_toolCallId: string,
						params: {
							agent: string;
							task: string;
							maxTurns?: number;
							maxTokens?: number;
							timeoutMs?: number;
							thinking?: string;
						},
					) {
						const limits = parseLimits(params);
						const result = await spawn({
							agent: params.agent,
							task: params.task,
							limits: limits.thinking
								? { ...limits, thinking: limits.thinking as ThinkingLevel }
								: { ...limits },
						});
						return {
							content: [{ type: "text" as const, text: result.resultText }],
							usage: result.usage,
							details: result.details,
						};
					},
				}),
			);
		},
	};
}
