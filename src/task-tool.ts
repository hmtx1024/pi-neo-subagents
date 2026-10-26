/**
 * The `task` tool: the host agent's delegation entry point. Three dispatch
 * shapes (one, a fan-out, an ordered chain), the TUI live view, and the result
 * contract handed back to the host model.
 */

import { join } from "node:path";

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { authorizeAgents } from "./authorize.ts";
import type { AgentDefinition } from "./agents.ts";
import { buildBridges } from "./bridges.ts";
import {
	delegateTask,
	delegationTarget,
	identityOf,
	runSessionFor,
	type DelegationOutcome,
	type TaskDetails,
} from "./delegate.ts";
import {
	dispatchChain,
	dispatchParallel,
	totalUsage,
} from "./dispatch.ts";
import { formatOutcomes } from "./output.ts";
import type { LedgerStatus } from "./ledger.ts";
import type { SubagentSettings } from "./settings.ts";
import {
	budgetDefaults,
	dispatchShape,
	stepDetails,
	taskParameters,
} from "./task-params.ts";

/** Widget key for the live delegation view (TUI only). */
export const LIVE_WIDGET_KEY = "subagents";



export function buildTaskDescription(agents: AgentDefinition[], cwd: string, agentDir: string): string {
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


export type StepDetails = ReturnType<typeof stepDetails>;

export interface ChainDetails {
	steps: StepDetails;
}

export interface ParallelDetails {
	tasks: StepDetails;
}

export function createTaskTool(
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
			// Child sessions are persisted only when this session is.
			const runSession = runSessionFor(ctx.sessionManager);
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
				// Seed the step that is about to run; later steps appear when they
				// take their first turn (a skipped step must never get a row).
				if (steps[0]) {
					live.set("0", { agent: identityOf(steps[0]), turn: 0 });
					renderLive();
				}
				const outcomes = await dispatchChain({
					cwd: ctx.cwd,
					registry: ctx.modelRegistry,
					hostModel: ctx.model,
					steps,
					signal,
					onRun: recordRun,
					maxDepth: getSettings().maxDepth,
					bridges,
					runSession,
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
					runSession,
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
					details: { tasks: stepDetails(outcomes) },
				};
			}

			const single = shape.single!;
			live.set("0", { agent: identityOf(single), turn: 0 });
			renderLive();
			let outcome: DelegationOutcome;
			try {
				outcome = await delegateTask({
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
					runSession,
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
			} finally {
				// A failed or cancelled delegation must not leave a ghost row.
				track.settle("0")();
			}
			return {
				content: [{ type: "text", text: outcome.resultText }],
				usage: outcome.usage,
				details: outcome.details,
			};
		},
	});
}

