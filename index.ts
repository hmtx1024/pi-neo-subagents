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
import {
	foldEntries,
	RESET_ENTRY_TYPE,
	RUN_ENTRY_TYPE,
	RunLedger,
	type LedgerStatus,
	type RunRecordData,
} from "./src/ledger.ts";
import { readSubagentSettings, type SubagentSettings } from "./src/settings.ts";
import { buildTaskDescription, createTaskTool } from "./src/task-tool.ts";

export default function (pi: ExtensionAPI) {
	let currentCwd = process.cwd();
	let inventorySignature = "";
	// Replaced wholesale when the session log is replayed (see rebuildLedger).
	let ledger = new RunLedger();
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

	/** Replace the in-memory ledger with a replay of the current session log. */
	const rebuildLedger = (ctx: { sessionManager: { getEntries(): readonly unknown[] } }) => {
		ledger = foldEntries(ctx.sessionManager.getEntries() as Parameters<typeof foldEntries>[0]);
	};

	/**
	 * Account for one delegation (any depth); failures and budget stops are counted
	 * apart. The session log is the durable copy — the in-memory ledger is the
	 * view this session renders from.
	 */
	const recordRun = (record: { agent: string; status: LedgerStatus; details: TaskDetails }) => {
		ledger.record({
			agent: record.agent,
			status: record.status,
			turns: record.details.turns,
			usage: record.details.usage,
			durationMs: record.details.durationMs,
			depth: record.details.depth,
		});
		const data: RunRecordData = {
			v: 1,
			agent: record.agent,
			status: record.status,
			turns: record.details.turns,
			...(record.details.model ? { model: record.details.model } : {}),
			...(record.details.depth !== undefined ? { depth: record.details.depth } : {}),
			...(record.details.durationMs !== undefined ? { durationMs: record.details.durationMs } : {}),
			...(record.details.usage ? { usage: record.details.usage } : {}),
			...(record.details.sessionId ? { sessionId: record.details.sessionId } : {}),
		};
		pi.appendEntry(RUN_ENTRY_TYPE, data);
	};

	/** `stats reset`: clear the view and leave a tombstone so a resume stays empty. */
	const resetLedger = () => {
		ledger.reset();
		pi.appendEntry(RESET_ENTRY_TYPE, { v: 1 });
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
		// Replay the session log instead of starting empty: that is what makes
		// `/subagents stats` survive a resume. New sessions have an empty log, so
		// no reason branching is needed; the fold replaces state, never adds to it.
		rebuildLedger(ctx);
		approvals.clear();
		refreshTaskTool();
	});
	pi.on("before_agent_start", (_event, ctx) => {
		currentCwd = ctx.cwd;
		refreshTaskTool();
	});

	pi.registerCommand("subagents", {
		description: "List and inspect subagent definitions; run one directly",
		handler: (args, ctx) => handleSubagentsCommand(args, ctx, { pi, getSettings, recordRun, resetLedger, ledger }),
	});
}
