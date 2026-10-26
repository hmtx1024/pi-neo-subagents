/**
 * Ticket 07 — task-only ad-hoc entries.
 *
 * Real-world failure (session export, test002): a model put the whole job into
 * `task` — the natural input — and our validation sent it chasing
 * `instructions`, which the schema then paired with a required `task`: two
 * wasted host rounds before the right shape emerged. A task-only entry is
 * unambiguous (generic worker persona), so it must simply work.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";

import { createTestSession, toolResultText } from "./harness.ts";

interface ToolResultMessage {
	isError?: boolean;
	content: Array<{ type: string; text?: string }>;
}

function lastToolResult(session: { messages: unknown[] }, toolName: string): ToolResultMessage {
	const results = (session.messages as Array<{ role: string; toolName?: string }>).filter(
		(message) => message.role === "toolResult" && message.toolName === toolName,
	);
	return results[results.length - 1] as unknown as ToolResultMessage;
}

function userText(context: TranscriptContext): string {
	return context.messages
		.filter((message) => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: ((message.content ?? []) as Array<{ text?: string }>).map((block) => block.text ?? "").join("\n"),
		)
		.join("\n");
}

/** Instructions ride the system addendum (definition body), not the user message. */
function systemAddendum(context: TranscriptContext): string {
	const system = context.messages.find((message) => message.role === "system") as
		| { sections?: { addendum?: string } }
		| undefined;
	return system?.sections?.addendum ?? "";
}

function writeAgent(root: string, name: string): void {
	const dir = join(root, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.md`), ["---", `description: The ${name} agent`, "---", "", "Body.", ""].join("\n"));
}

it("accepts a task-only fan-out entry and fills a default worker persona", async () => {
	const { session, faux, dispose } = await createTestSession();
	try {
		let nestedUser = "";
		let nestedAddendum = "";
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					tasks: [{ task: "Create only.txt containing the word solo", maxTurns: 3 }],
				}),
				{ stopReason: "toolUse" },
			),
			(context: TranscriptContext) => {
				nestedUser = userText(context);
				nestedAddendum = systemAddendum(context);
				return fauxAssistantMessage("done");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Do one small thing.");

		const result = lastToolResult(session, "task");
		expect(result.isError).toBeFalsy();
		expect(toolResultText(result)).toContain("done");
		// The job text reaches the subagent, and so does a default persona.
		expect(nestedUser).toContain("Create only.txt containing the word solo");
		expect(nestedAddendum).toMatch(/careful worker/i);
	} finally {
		dispose();
	}
});

it("accepts a task-only single delegation", async () => {
	const { session, faux, dispose } = await createTestSession();
	try {
		let nestedUser = "";
		let nestedAddendum = "";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { task: "Say hello exactly once" }), { stopReason: "toolUse" }),
			(context: TranscriptContext) => {
				nestedUser = userText(context);
				nestedAddendum = systemAddendum(context);
				return fauxAssistantMessage("hello");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate the greeting.");

		const result = lastToolResult(session, "task");
		expect(result.isError).toBeFalsy();
		expect(toolResultText(result)).toBe("hello");
		expect(nestedUser).toContain("Say hello exactly once");
		expect(nestedAddendum).toMatch(/careful worker/i);
	} finally {
		dispose();
	}
});

it("still rejects an entry that names both an agent and instructions", async () => {
	const { session, faux, dispose } = await createTestSession({
		setup: ({ cwd }) => writeAgent(cwd, "alpha"),
	});
	try {
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					tasks: [{ agent: "alpha", instructions: "Also inline.", task: "Do it" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate.");

		const result = lastToolResult(session, "task");
		expect(result.isError).toBe(true);
		expect(toolResultText(result)).toMatch(/not both|either/i);
	} finally {
		dispose();
	}
});

it("still rejects empty inline instructions", async () => {
	const { session, faux, dispose } = await createTestSession();
	try {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { instructions: " ", task: "Do it" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate.");

		const result = lastToolResult(session, "task");
		expect(result.isError).toBe(true);
		expect(toolResultText(result)).toMatch(/empty/i);
	} finally {
		dispose();
	}
});
