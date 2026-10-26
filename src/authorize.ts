/**
 * Consent for project-level definitions. Repository-controlled prompts can
 * instruct a model to run commands, so their first use in a session asks.
 * Answers are remembered per agent for the session; ad-hoc and user-level
 * agents never ask.
 */

import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { discoverAgents } from "./agents.ts";
import type { DispatchTask } from "./dispatch.ts";
import type { SubagentSettings } from "./settings.ts";

/**
 * Consent for project-level agents: repository-controlled prompts can instruct a
 * model to run commands, so their first use in a session asks. Answers are
 * remembered per agent for the session; ad-hoc and user-level agents never ask.
 */
export async function authorizeAgents(
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

