/**
 * The `/subagents` command family: list, inspect, scaffold, edit, delete, run,
 * and the session ledger. Argument parsing here is deliberately strict —
 * `/subagents run` never rewrites the task text it was given.
 */

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import {
	createAgentDefinition,
	discoverAgents,
	parseAgentText,
	type AgentDefinition,
} from "./agents.ts";
import { delegateTask, resolveModel, runSessionFor, type TaskDetails } from "./delegate.ts";
import { formatLedger, type LedgerStatus, type RunLedger } from "./ledger.ts";
import { formatDirectRun, formatTimestamp, present } from "./output.ts";
import type { SubagentSettings } from "./settings.ts";
import { budgetDefaults } from "./task-params.ts";

export const RUN_USAGE = "Usage: /subagents run <name> [--to-context] <task>";

export interface RunArguments {
	name: string;
	task: string;
	toContext: boolean;
}

/**
 * Parse `/subagents run` arguments strictly: options only before the name, a
 * `--` terminator, and quoted names. The task text is never rewritten.
 */
export function parseRunArguments(raw: string):
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
export function definitionPath(agent: AgentDefinition, projectAgentsDir: string, agentDir: string): string {
	return agent.source === "project"
		? join(projectAgentsDir, agent.file)
		: join(agentDir, "agents", agent.file);
}

/** Find one definition by name, or report what does exist. */
export function findDefinition(ctx: ExtensionCommandContext, name: string) {
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
export async function handleNew(rest: string, ctx: ExtensionCommandContext): Promise<void> {
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
export async function handleEdit(rest: string, ctx: ExtensionCommandContext): Promise<void> {
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
export async function handleRemove(rest: string, ctx: ExtensionCommandContext): Promise<void> {
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
export async function handleRun(
	rest: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	getSettings: () => SubagentSettings,
	recordRun: (record: { agent: string; status: LedgerStatus; details: TaskDetails }) => void,
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
			maxDepth: getSettings().maxDepth,
			defaults: budgetDefaults(getSettings()),
			runSession: runSessionFor(ctx.sessionManager),
			onRun: recordRun,
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


/** `/subagents` subcommand routing, so the entry file only registers. */
export interface CommandDeps {
	pi: ExtensionAPI;
	getSettings: () => SubagentSettings;
	recordRun: (record: { agent: string; status: LedgerStatus; details: TaskDetails }) => void;
	/** Clear the ledger and leave a reset entry in the session log. */
	resetLedger: () => void;
	ledger: RunLedger;
}

export async function handleSubagentsCommand(
	args: string,
	ctx: ExtensionCommandContext,
	deps: CommandDeps,
): Promise<void> {
	const trimmed = args.trim();
	if (trimmed === "run" || trimmed.startsWith("run ")) {
		await handleRun(trimmed.slice("run".length).trim(), ctx, deps.pi, deps.getSettings, deps.recordRun);
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
		present(ctx, formatLedger(deps.ledger));
		return;
	}
	if (trimmed === "stats reset") {
		deps.resetLedger();
		present(ctx, "Delegation ledger reset.");
		return;
	}
	const { agents, errors } = discoverAgents(ctx.cwd, getAgentDir());
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
			present(
				ctx,
				`No agent definition named "${name}". Available: ${agents.map((candidate) => candidate.name).join(", ")}.`,
				"error",
			);
			return;
		}
		const tools = agent.tools?.join(", ") ?? "all default";
		const model = agent.model ?? "inherit";
		const origin = agent.overridesUser ? "project, overrides user definition" : agent.source;
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
			const origin = `${agent.source}: ${agent.file}${
				agent.modifiedAt === undefined ? "" : ` · ${formatTimestamp(agent.modifiedAt)}`
			}`;
			return `- ${agent.name} — ${agent.description} (tools: ${tools} | model: ${model} | ${origin})${override}`;
		}),
	];
	present(ctx, lines.join("\n"));
}

