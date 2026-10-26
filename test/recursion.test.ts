/**
 * Ticket 11 — controlled recursion.
 *
 * A definition can opt into spawning subagents. Opted-in agents get the `task`
 * tool in their nested session, a depth limit bounds the tree, and every result
 * reports the depth it ran at. Definitions without the opt-in stay unable to
 * delegate.
 */

import { mkdirSync, writeFileSync } from "node:fs";
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
		(message) => message.role === "toolResult" && message.toolName === toolName,
	);
	return results[results.length - 1] as unknown as ToolResultMessage;
}

function writeAgent(root: string, name: string, frontmatter: string[] = []): void {
	const dir = join(root, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.md`),
		["---", `description: The ${name} agent`, ...frontmatter, "---", "", "Body.", ""].join("\n"),
	);
}

function declaredToolNames(context: TranscriptContext): string[] {
	const names: string[] = [];
	for (const message of context.messages) {
		const added = (message as { toolsAdded?: Array<{ name?: string }> }).toolsAdded;
		if (!Array.isArray(added)) continue;
		for (const entry of added) if (entry?.name) names.push(entry.name);
	}
	return names;
}

/** Last task tool-result text inside a nested transcript. */
function nestedToolResultText(context: TranscriptContext): string {
	const results = context.messages.filter(
		(message): message is Extract<(typeof context.messages)[number], { role: "toolResult" }> =>
			message.role === "toolResult",
	);
	const last = results[results.length - 1] as unknown as { content: Array<{ type: string; text?: string }> };
	return last === undefined
		? ""
		: last.content
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("");
}

function writeSettings(agentDir: string, subagents: Record<string, unknown>): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ subagents }, null, 2));
}

function hostDelegation(agent: string, task = "Do it.") {
	return fauxAssistantMessage(fauxToolCall("task", { agent, task }), { stopReason: "toolUse" });
}

it("gives an opted-in agent the task tool and runs a second level", async () => {
	const { session, faux, root, dispose } = await createTestSession();
	try {
		writeAgent(root, "lead", ["allowSubagents: true"]);
		writeAgent(root, "worker");

		let leadTools: string[] = [];
		const leadTurn1: FauxResponseFactory = (context) => {
			leadTools = declaredToolNames(context);
			return fauxAssistantMessage(fauxToolCall("task", { agent: "worker", task: "do the work" }), {
				stopReason: "toolUse",
			});
		};

		faux.setResponses([
			hostDelegation("lead", "plan the work"),
			leadTurn1,
			(_context) => fauxAssistantMessage("worker done"),
			(_context) => fauxAssistantMessage("lead done"),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate to the lead.");

		const result = lastToolResult(session, "task");
		expect(result.isError).toBeFalsy();
		expect(toolResultText(result)).toBe("lead done");
		expect(leadTools).toContain("task");
		expect((result.details as { depth?: number }).depth).toBe(1);
	} finally {
		dispose();
	}
});

it("keeps the task tool away from agents that did not opt in", async () => {
	const { session, faux, root, dispose } = await createTestSession();
	try {
		writeAgent(root, "plain");

		let nestedTools: string[] = [];
		faux.setResponses([
			hostDelegation("plain"),
			(context) => {
				nestedTools = declaredToolNames(context);
				return fauxAssistantMessage("plain reply");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate to the plain agent.");

		expect(nestedTools).toContain("bash");
		expect(nestedTools).not.toContain("task");
	} finally {
		dispose();
	}
});

it("refuses a spawn beyond the depth limit with a clear message", async () => {
	const { session, faux, root, dispose } = await createTestSession({
		setup: ({ agentDir }) => writeSettings(agentDir, { maxDepth: 1 }),
	});
	try {
		writeAgent(root, "lead", ["allowSubagents: true"]);
		writeAgent(root, "worker");

		let refusalSeenByNestedModel = "";
		faux.setResponses([
			hostDelegation("lead"),
			// Depth 1 may not spawn again when maxDepth is 1.
			fauxAssistantMessage(fauxToolCall("task", { agent: "worker", task: "nested" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				refusalSeenByNestedModel = nestedToolResultText(context);
				return fauxAssistantMessage("lead reported the refusal");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate to the lead.");

		// The nested session surfaced the refusal to its own model, which reported it.
		expect(refusalSeenByNestedModel).toMatch(/depth/i);
		expect(refusalSeenByNestedModel).toContain("1");
	} finally {
		dispose();
	}
});

it("reports depth in the ledger", async () => {
	const { session, faux, root, ui, dispose } = await createTestSession();
	try {
		writeAgent(root, "lead", ["allowSubagents: true"]);
		writeAgent(root, "worker");

		faux.setResponses([
			hostDelegation("lead"),
			fauxAssistantMessage(fauxToolCall("task", { agent: "worker", task: "nested" }), {
				stopReason: "toolUse",
			}),
			(_context) => fauxAssistantMessage("worker done"),
			(_context) => fauxAssistantMessage("lead done"),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate to the lead.");
		await session.prompt("/subagents stats");

		const stats = userOutput(ui);
		expect(stats).toContain("lead");
		expect(stats).toContain("worker");
		expect(stats).toMatch(/depth/i);
	} finally {
		dispose();
	}
});

it("honours the configured maximum depth when running through the command", async () => {
	const { session, faux, root, dispose, agentDir } = await createTestSession();
	try {
		// Settings default (maxDepth 2) is enough for one level of nesting; the
		// command path used to drop the setting and fall back to 1.
		writeSettings(agentDir, { confirmProjectAgents: "allow" });
		writeAgent(root, "lead", ["allowSubagents: true"]);
		writeAgent(root, "worker");

		let sawDepthError = false;
		let sawChildReply = false;
		faux.setResponses([
			// lead (depth 1) asks to delegate one level deeper
			fauxAssistantMessage(fauxToolCall("task", { agent: "worker", task: "child work" }), {
				stopReason: "toolUse",
			}),
			// the worker (depth 2) answers
			fauxAssistantMessage("child done"),
			// back in lead: the tool result tells us whether the child really ran
			(context: TranscriptContext) => {
				const dump = JSON.stringify(context.messages);
				sawDepthError = /depth limit/i.test(dump);
				sawChildReply = /child done/.test(dump);
				return fauxAssistantMessage("lead done");
			},
		]);

		await session.prompt("/subagents run lead Do the thing");

		expect(sawDepthError).toBe(false);
		expect(sawChildReply).toBe(true);
	} finally {
		dispose();
	}
});
