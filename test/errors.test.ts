/**
 * Error surfaces: a wrong agent name must tell the caller what does exist, and
 * the empty-inventory wording is the same everywhere.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";

import { createTestSession, toolResultText, userOutput } from "./harness.ts";

function writeAgent(cwd: string, file: string, description: string): void {
	const agentsDir = join(cwd, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, file), ["---", `description: ${description}`, "---", "", "Body.", ""].join("\n"));
}

it("lists the available agents when a delegated name is unknown", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer.md", "Reviews code changes");
		writeAgent(cwd, "explorer.md", "Explores code");
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", { agent: "ghost", task: "Do something" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Please delegate.");

		const results = session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "task",
		) as Array<{ content: Array<{ type: string; text?: string }> }>;
		const text = toolResultText(results[0]);
		expect(text).toContain('No agent definition named "ghost".');
		expect(text).toMatch(/available/i);
		expect(text).toContain("reviewer");
		expect(text).toContain("explorer");
	} finally {
		dispose();
	}
});

it("lists the available agents when a direct-run name is unknown", async () => {
	const { session, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer.md", "Reviews code changes");

		await session.prompt("/subagents run ghost Do something");

		const output = userOutput(ui);
		expect(output).toContain('No agent definition named "ghost".');
		expect(output).toContain("reviewer");
	} finally {
		dispose();
	}
});

it("uses the same empty-inventory wording in the task tool description", async () => {
	const { session, faux, dispose } = await createTestSession();
	try {
		const captured: string[] = [];
		faux.setResponses([
			(context: TranscriptContext) => {
				for (const message of context.messages) {
					if (message.role === "system") captured.push(JSON.stringify(message));
				}
				return fauxAssistantMessage("ok");
			},
		]);

		await session.prompt("Hello.");

		expect(captured.join("\n")).toContain("No agent definitions found.");
	} finally {
		dispose();
	}
});
