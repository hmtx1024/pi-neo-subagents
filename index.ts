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

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { discoverAgents } from "./src/agents.ts";
import { handleSubagentsCommand } from "./src/commands.ts";
import { createCreateSubagentTool } from "./src/create-tool.ts";
import type { TaskDetails } from "./src/delegate.ts";
import { RunLedger, type LedgerStatus } from "./src/ledger.ts";
import { readSubagentSettings, type SubagentSettings } from "./src/settings.ts";
import { buildTaskDescription, createTaskTool } from "./src/task-tool.ts";

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
		handler: (args, ctx) => handleSubagentsCommand(args, ctx, { pi, getSettings, recordRun, ledger }),
	});
}
