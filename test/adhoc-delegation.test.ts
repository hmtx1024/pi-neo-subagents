/**
 * Ticket 05 — ad-hoc (definition-free) delegation.
 *
 * One-shot work is delegated with inline instructions: no file is written, no
 * definition appears in `/subagents`, the run is still accounted for, and an
 * inline agent can never spawn subagents.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/compat";

import { createTestSession, toolResultText, userOutput } from "./harness.ts";

interface ToolResultMessage {
	isError?: boolean;
	content: Array<{ type: string; text?: string }>;
	details?: Record<string, unknown>;
}

function lastToolResult(session: { messages: unknown[] }, toolName: string): ToolResultMessage {
	const results = (session.messages as Array<{ role: string; toolName?: string }>).filter(
		(message) => message.role === "toolResult" && message.toolName === taskToolName(),
	);
	return results[results.length - 1] as unknown as ToolResultMessage;
}

function taskToolName(): string {
	return "task";
}

function taskTextOf(context: TranscriptContext): string {
	for (const message of context.messages) {
		if (message.role !== "user") continue;
		const content = (message as { content: Array<{ type: string; text?: string }> }).content;
		const text = content
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join(" ");
		if (text !== "") return text;
	}
	return "";
}

it("delegates inline instructions without any definition or file on disk", async () => {
	const { session, faux, ui, cwd, dispose } = await createTestSession();
	try {
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					instructions: "You write small Python programs and verify them.",
					task: "Write hello.py",
				}),
				{ stopReason: "toolUse" },
			),
			(_context) => fauxAssistantMessage("wrote hello.py"),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Write a python hello world with a subagent.");

		const result = lastToolResult(session, "task");
		expect(result.isError).toBeFalsy();
		expect(toolResultText(result)).toBe("wrote hello.py");
		expect(existsSync(join(cwd, ".pi", "agents"))).toBe(false);

		await session.prompt("/subagents");
		expect(userOutput(ui)).toMatch(/no agent definitions found/i);

		await session.prompt("/subagents stats");
		const stats = userOutput(ui);
		expect(stats).toContain("ad-hoc");
		expect(stats).toMatch(/1 run/i);
	} finally {
		dispose();
	}
});

it("honours an inline tool whitelist, model, and budget", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		let toolsAdded = "";
		let nestedModelId = "";
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					instructions: "You only read files.",
					tools: ["read"],
					model: "faux-2",
					maxTurns: 2,
					task: "Read one file",
				}),
				{ stopReason: "toolUse" },
			),
			(context, _options, _state, model) => {
				nestedModelId = model.id;
				toolsAdded = context.messages
					.filter((message) => message.role === "system")
					.map((message) => JSON.stringify((message as { toolsAdded?: unknown }).toolsAdded ?? ""))
					.join("\n");
				return fauxAssistantMessage("read it");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate with an inline spec.");

		const result = lastToolResult(session, "task");
		expect(result.isError).toBeFalsy();
		expect(toolResultText(result)).toBe("read it");
		expect(nestedModelId).toBe("faux-2");
		expect(toolsAdded).toContain("read");
		expect(toolsAdded).not.toContain("bash");
		expect(toolsAdded).not.toContain('"write"');

		const details = result.details as { model?: string; budgetStop?: unknown };
		expect(details.model).toBe("faux-2");
		expect(details.budgetStop).toBeUndefined();
	} finally {
		dispose();
	}
});

it("never gives an inline agent the task tool", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		let toolsAdded = "";
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					instructions: "You may delegate work to other agents.",
					task: "Do it",
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				toolsAdded = context.messages
					.filter((message) => message.role === "system")
					.map((message) => JSON.stringify((message as { toolsAdded?: unknown }).toolsAdded ?? ""))
					.join("\n");
				return fauxAssistantMessage("done");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate to an inline agent.");

		expect(toolsAdded).toContain("bash");
		expect(toolsAdded).not.toContain('"task"');
		expect(toolsAdded).not.toContain("Delegate work to named subagents");
	} finally {
		dispose();
	}
});

it("rejects an entry with both an agent and instructions, and one without a task", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		const agentsDir = join(cwd, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, "reviewer.md"), ["---", "description: Reviews code", "---", "", "Body.", ""].join("\n"));

		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					agent: "reviewer",
					instructions: "Also inline instructions.",
					task: "Do it",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("task", { agent: "reviewer" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Try invalid entries.");

		const results = (session.messages as Array<{ role: string; toolName?: string }>).filter(
			(message) => message.role === "toolResult" && message.toolName === "task",
		) as unknown as ToolResultMessage[];
		expect(results).toHaveLength(2);
		expect(results[0].isError).toBe(true);
		expect(toolResultText(results[0])).toMatch(/not both|either/i);
		expect(results[1].isError).toBe(true);
		// Task-only entries are valid now (ticket 07); what remains invalid is
		// an entry without a task.
		expect(toolResultText(results[1])).toMatch(/task/i);
	} finally {
		dispose();
	}
});

it("works in fan-out and chain dispatch", async () => {
	const { session, faux, ui, cwd, dispose } = await createTestSession();
	try {
		const echo: FauxResponseFactory = (context) => fauxAssistantMessage(`reply for ${taskTextOf(context)}`);
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					tasks: [
						{ instructions: "You write Python.", task: "task one" },
						{ instructions: "You write Go.", task: "task two" },
					],
				}),
				{ stopReason: "toolUse" },
			),
			echo,
			echo,
			fauxAssistantMessage(
				fauxToolCall("task", {
					chain: [
						{ instructions: "You draft.", task: "draft step" },
						{ instructions: "You refine.", task: "refine using {previous}" },
					],
				}),
				{ stopReason: "toolUse" },
			),
			echo,
			echo,
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Fan out with inline agents.");
		await session.prompt("Chain with inline agents.");

		const text = userOutput(ui);
		expect(text).toBe("");

		const results = (session.messages as Array<{ role: string; toolName?: string }>).filter(
			(message) => message.role === "toolResult" && message.toolName === "task",
		) as unknown as ToolResultMessage[];
		expect(results).toHaveLength(2);
		expect(toolResultText(results[0])).toContain("reply for task one");
		expect(toolResultText(results[0])).toContain("reply for task two");
		expect(toolResultText(results[1])).toContain("reply for refine using reply for draft step");

		await session.prompt("/subagents stats");
		expect(userOutput(ui)).toMatch(/ad-hoc: 4 runs/i);
	} finally {
		dispose();
	}
});
