/**
 * Ticket 02 — run ledger and `/subagents stats`.
 *
 * Every delegation is accounted for per agent: runs, successes, failures,
 * budget stops, turns, tokens, cost, and time. `/subagents stats` renders it and
 * `stats reset` clears it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";

import { captureStdio, createTestSession, userOutput } from "./harness.ts";

function writeAgent(cwd: string, name: string, description: string, frontmatter: string[] = []): void {
	const dir = join(cwd, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.md`), ["---", `description: ${description}`, ...frontmatter, "---", "", "Body.", ""].join("\n"));
}

function hostDelegation(target: string, args: Record<string, unknown> = {}) {
	return fauxAssistantMessage(fauxToolCall("task", { agent: target, task: "Do it.", ...args }), {
		stopReason: "toolUse",
	});
}

it("accumulates runs, turns, tokens, cost, and time per agent", async () => {
	const { session, faux, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer", "Reviews code");
		faux.setResponses([
			hostDelegation("reviewer"),
			fauxAssistantMessage("first reply"),
			hostDelegation("reviewer"),
			fauxAssistantMessage("second reply"),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate twice.");
		await session.prompt("/subagents stats");

		const output = userOutput(ui);
		expect(output).toContain("reviewer");
		expect(output).toMatch(/2 run/i);
		expect(output).toMatch(/2 turn/i);
		expect(output).toMatch(/tokens?/i);
		expect(output).toMatch(/cost|\$/i);
		expect(output).toMatch(/avg|average/i);
	} finally {
		dispose();
	}
});

it("counts failures and budget stops separately from successes", async () => {
	const { session, faux, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer", "Reviews code", ["maxTurns: 1"]);
		faux.setResponses([
			// ok
			hostDelegation("reviewer"),
			fauxAssistantMessage("clean reply"),
			// failure: unknown agent
			hostDelegation("ghost"),
			// budget stop
			hostDelegation("reviewer"),
			fauxAssistantMessage([fauxText("partial"), fauxToolCall("bash", { command: "echo x" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Run three delegations.");
		await session.prompt("/subagents stats");

		const output = userOutput(ui);
		expect(output).toMatch(/3 run/i);
		expect(output).toMatch(/1 failed/i);
		expect(output).toMatch(/1 budget/i);
		expect(output).toMatch(/ghost/);
	} finally {
		dispose();
	}
});

it("resets the ledger on request", async () => {
	const { session, faux, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer", "Reviews code");
		faux.setResponses([
			hostDelegation("reviewer"),
			fauxAssistantMessage("a reply"),
			fauxAssistantMessage("Understood."),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate once.");
		await session.prompt("/subagents stats reset");
		expect(userOutput(ui)).toMatch(/reset/i);

		await session.prompt("/subagents stats");
		expect(userOutput(ui)).toMatch(/no .*runs?.*yet|no delegations?/i);
		expect(userOutput(ui)).not.toContain("1 run");
	} finally {
		dispose();
	}
});

it("starts empty in a new session", async () => {
	const first = await createTestSession();
	try {
		writeAgent(first.cwd, "reviewer", "Reviews code");
		first.faux.setResponses([
			hostDelegation("reviewer"),
			fauxAssistantMessage("a reply"),
			fauxAssistantMessage("Understood."),
		]);
		await first.session.prompt("Delegate once.");
	} finally {
		first.dispose();
	}

	const second = await createTestSession();
	try {
		await second.session.prompt("/subagents stats");
		expect(userOutput(second.ui)).toMatch(/no .*runs?.*yet|no delegations?/i);
	} finally {
		second.dispose();
	}
});

it("reports stats on stdout in print mode", async () => {
	const stdio = captureStdio();
	const { session, faux, cwd, dispose } = await createTestSession({ mode: "print" });
	try {
		writeAgent(cwd, "reviewer", "Reviews code");
		faux.setResponses([
			hostDelegation("reviewer"),
			fauxAssistantMessage("a reply"),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate once.");
		await session.prompt("/subagents stats");

		expect(stdio.stdout()).toMatch(/reviewer/);
		expect(stdio.stdout()).toMatch(/1 run/i);
	} finally {
		dispose();
		stdio.restore();
	}
});

it("counts a direct run in the ledger", async () => {
	const { session, faux, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer", "Reviews code");
		faux.setResponses([fauxAssistantMessage("reviewed it")]);

		await session.prompt("/subagents run reviewer Review the changes");
		await session.prompt("/subagents stats");

		const output = userOutput(ui);
		expect(output).toContain("reviewer");
		expect(output).toMatch(/1 run/i);
	} finally {
		dispose();
	}
});
