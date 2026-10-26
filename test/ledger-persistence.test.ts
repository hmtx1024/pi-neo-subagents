/**
 * Ticket 12 — the ledger lives in the session log.
 *
 * Nothing new is stored: one custom entry per delegation goes into pi's own
 * session file, and `/subagents stats` is a fold over those entries. That makes
 * "stats survive a resume" true without a second store, a schema migration, or
 * a rotation policy.
 *
 * These tests observe the session log itself (the seam that makes the feature
 * meaningful), plus the user-visible `/subagents stats` output.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";

import { createTestSession, userOutput } from "./harness.ts";

const RUN_TYPE = "pi-neo-subagents/run";
const RESET_TYPE = "pi-neo-subagents/reset";

interface CustomEntryLike {
	type: string;
	customType?: string;
	data?: Record<string, unknown>;
}

function writeAgent(root: string, name: string): void {
	const dir = join(root, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.md`), ["---", `description: The ${name} agent`, "---", "", "Body.", ""].join("\n"));
}

function customEntries(session: { sessionManager: { getEntries(): unknown[] } }, customType?: string): CustomEntryLike[] {
	return (session.sessionManager.getEntries() as CustomEntryLike[]).filter(
		(entry) => entry.type === "custom" && (customType === undefined || entry.customType === customType),
	);
}

function delegation(agent: string, extra: Record<string, unknown> = {}) {
	return fauxAssistantMessage(fauxToolCall("task", { agent, task: "Do it.", ...extra }), { stopReason: "toolUse" });
}

/** What a resumed session's log looks like: runs, optionally interleaved with a reset. */
function runRecord(agent: string, turns: number, status = "ok"): { customType: string; data: unknown } {
	return {
		customType: RUN_TYPE,
		data: {
			v: 1,
			agent,
			status,
			turns,
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
}

it("records one session-log entry per delegation", async () => {
	const { session, faux, root, dispose } = await createTestSession();
	try {
		writeAgent(root, "reviewer");
		faux.setResponses([delegation("reviewer"), fauxAssistantMessage("reviewed"), fauxAssistantMessage("done")]);

		await session.prompt("Delegate.");

		const runs = customEntries(session, RUN_TYPE);
		expect(runs).toHaveLength(1);
		expect(runs[0].data).toMatchObject({ v: 1, agent: "reviewer", status: "ok" });
		expect(typeof runs[0].data?.turns).toBe("number");
	} finally {
		dispose();
	}
});

it("keeps its entries out of the model's context", async () => {
	const { session, faux, root, dispose } = await createTestSession();
	try {
		writeAgent(root, "reviewer");
		faux.setResponses([delegation("reviewer"), fauxAssistantMessage("reviewed"), fauxAssistantMessage("done")]);

		await session.prompt("Delegate.");

		const context = JSON.stringify(
			(session.messages as Array<{ role: string }>).filter((message) => message.role !== "system"),
		);
		expect(context).not.toContain(RUN_TYPE);
		expect(context).not.toContain("pi-neo-subagents");
	} finally {
		dispose();
	}
});

it("rebuilds the ledger from a resumed session's entries", async () => {
	const { session, ui, dispose } = await createTestSession({
		seedEntries: [runRecord("reviewer", 3), runRecord("scout", 2)],
	});
	try {
		await session.prompt("/subagents stats");

		const output = userOutput(ui);
		expect(output).toContain("reviewer");
		expect(output).toContain("scout");
		expect(output).toMatch(/2 runs/i);
	} finally {
		dispose();
	}
});

it("ignores everything recorded before a reset tombstone", async () => {
	const { session, ui, dispose } = await createTestSession({
		seedEntries: [runRecord("reviewer", 3), { customType: RESET_TYPE, data: { v: 1 } }, runRecord("scout", 2)],
	});
	try {
		await session.prompt("/subagents stats");

		const output = userOutput(ui);
		expect(output).toContain("scout");
		expect(output).not.toContain("reviewer");
	} finally {
		dispose();
	}
});

it("writes a tombstone when the ledger is reset, so a resume stays empty", async () => {
	const { session, faux, root, ui, dispose } = await createTestSession();
	try {
		writeAgent(root, "reviewer");
		faux.setResponses([
			delegation("reviewer"),
			fauxAssistantMessage("reviewed"),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("done"),
		]);

		await session.prompt("Delegate.");
		await session.prompt("/subagents stats reset");

		const tombs = customEntries(session, RESET_TYPE);
		expect(tombs).toHaveLength(1);

		await session.prompt("/subagents stats");
		expect(userOutput(ui)).toMatch(/no .*runs?.*yet|no delegations?/i);
	} finally {
		dispose();
	}
});
