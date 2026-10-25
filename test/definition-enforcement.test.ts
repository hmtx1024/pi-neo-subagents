/**
 * Ticket 05 — definition enforcement.
 *
 * Spec-level behaviour: the declarative fields in agent definitions take real
 * effect on the nested session — tool whitelist, model override, system-prompt
 * mode — and a definition naming an unconfigured model fails loudly.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { TranscriptContext } from "@earendil-works/pi-ai";

import { createTestSession, toolResultText } from "./harness.ts";

function writeDefinition(cwd: string, file: string, lines: string[]): void {
	const agentsDir = join(cwd, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, file), lines.join("\n"));
}

function declaredTools(context: TranscriptContext): string {
	return context.messages
		.filter((message) => message.role === "system")
		.map((message) => JSON.stringify((message as { toolsAdded?: unknown }).toolsAdded ?? ""))
		.join("\n");
}

it("enforces the definition's tool whitelist and defaults to all default tools when omitted", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeDefinition(cwd, "reviewer.md", [
			"---",
			"description: Reviews code changes",
			"tools: read, grep",
			"---",
			"",
			"You are a careful code reviewer.",
			"",
		]);
		writeDefinition(cwd, "helper.md", [
			"---",
			"description: General helper",
			"---",
			"",
			"You help out.",
			"",
		]);

		const captured: string[] = [];
		const capture = (context: TranscriptContext) => {
			captured.push(declaredTools(context));
			return fauxAssistantMessage("ok");
		};
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", { agent: "reviewer", task: "Review the pending changes" }),
				{ stopReason: "toolUse" },
			),
			capture,
			fauxAssistantMessage("Done."),
			fauxAssistantMessage(
				fauxToolCall("task", { agent: "helper", task: "Summarize the situation" }),
				{ stopReason: "toolUse" },
			),
			capture,
			fauxAssistantMessage("Done."),
		]);

		await session.prompt("First delegation.");
		await session.prompt("Second delegation.");

		// Whitelist: only the declared tools.
		expect(captured[0]).toContain("read");
		expect(captured[0]).toContain("grep");
		expect(captured[0]).not.toContain("bash");
		expect(captured[0]).not.toContain('"write"');
		// Omitted: all default tools, and never `task`.
		expect(captured[1]).toContain("bash");
		expect(captured[1]).toContain('"write"');
		expect(captured[1]).not.toContain("task");
	} finally {
		dispose();
	}
});

it("runs the subagent on the model named in the definition", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeDefinition(cwd, "reviewer.md", [
			"---",
			"description: Reviews code changes",
			"model: faux-2",
			"---",
			"",
			"You are a careful code reviewer.",
			"",
		]);

		let subagentModelId = "";
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", { agent: "reviewer", task: "Review the pending changes" }),
				{ stopReason: "toolUse" },
			),
			(_context, _options, _state, model) => {
				subagentModelId = model.id;
				return fauxAssistantMessage("Looks good to me.");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Please have a reviewer look at the pending changes.");

		expect(subagentModelId).toBe("faux-2");
	} finally {
		dispose();
	}
});

it("replaces pi's default system prompt when the definition asks for it", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeDefinition(cwd, "reviewer.md", [
			"---",
			"description: Reviews code changes",
			"systemPrompt: replace",
			"---",
			"",
			"You are a careful code reviewer. Reply with JSON only.",
			"",
		]);

		let subagentSystemText = "";
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", { agent: "reviewer", task: "Review the pending changes" }),
				{ stopReason: "toolUse" },
			),
			(context) => {
				subagentSystemText = JSON.stringify(context.messages);
				return fauxAssistantMessage("{\"verdict\": \"ok\"}");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Please have a reviewer look at the pending changes.");

		expect(subagentSystemText).toContain("You are a careful code reviewer. Reply with JSON only.");
		expect(subagentSystemText).not.toContain("<rules>");
	} finally {
		dispose();
	}
});

it("fails loudly with a file-specific error when a definition names an unknown model", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeDefinition(cwd, "reviewer.md", [
			"---",
			"description: Reviews code changes",
			"model: nonexistent-9000",
			"---",
			"",
			"You are a careful code reviewer.",
			"",
		]);
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", { agent: "reviewer", task: "Review the pending changes" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Please have a reviewer look at the pending changes.");

		const result = session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "task",
		) as { isError: boolean; content: Array<{ type: string; text?: string }> } | undefined;

		expect(result).toBeDefined();
		expect(result!.isError).toBe(true);
		const text = toolResultText(result!);
		expect(text).toContain("reviewer.md");
		expect(text).toContain("nonexistent-9000");
		expect(text).toMatch(/model/i);
	} finally {
		dispose();
	}
});
