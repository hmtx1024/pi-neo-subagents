/**
 * Ticket 03 — `task` tool MVP.
 *
 * Spec-level behaviour: the main agent delegates a self-contained task to a
 * named subagent that runs in an isolated nested session (no host history),
 * and the subagent's final reply comes back as the tool result.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { TranscriptContext } from "@earendil-works/pi-ai";

import { createTestSession, toolResultText } from "./harness.ts";

it("delegates to a subagent in isolation and returns its final reply", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		const agentsDir = join(cwd, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			["---", "description: Reviews code changes", "---", "", "You are a careful code reviewer.", ""].join("\n"),
		);

		let subagentContextText = "";
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", { agent: "reviewer", task: "Review the pending changes" }),
				{ stopReason: "toolUse" },
			),
			(context) => {
				// This turn belongs to the subagent's nested session.
				subagentContextText = JSON.stringify(context.messages);
				return fauxAssistantMessage("Looks good to me.");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Please have a reviewer look at the pending changes.");

		const result = session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "task",
		) as { content: Array<{ type: string; text?: string }> } | undefined;

		expect(result).toBeDefined();
		expect(toolResultText(result!)).toBe("Looks good to me.");
		expect(subagentContextText).toContain("Review the pending changes");
		expect(subagentContextText).not.toContain("Please have a reviewer look at the pending changes");
	} finally {
		dispose();
	}
});

it("enumerates current agent definitions in the task tool description and refreshes on change", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		const agentsDir = join(cwd, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			["---", "description: Reviews code changes", "---", "", "You are a careful code reviewer.", ""].join("\n"),
		);

		const captured: string[] = [];
		const capturedToolDeltas: string[] = [];
		const capture = (context: TranscriptContext) => {
			captured.push(JSON.stringify(context.messages));
			for (const message of context.messages) {
				if (message.role === "system" && Array.isArray(message.toolsAdded) && message.toolsAdded.length > 0) {
					capturedToolDeltas.push(JSON.stringify(message.toolsAdded));
				}
			}
			return fauxAssistantMessage("ok");
		};
		faux.setResponses([capture, capture, capture]);

		await session.prompt("First prompt.");
		writeFileSync(
			join(agentsDir, "explorer.md"),
			["---", "description: Explores unfamiliar code", "---", "", "You explore code.", ""].join("\n"),
		);
		await session.prompt("Second prompt.");

		expect(captured[0]).toContain("reviewer");
		expect(captured[0]).toContain("Reviews code changes");
		expect(captured[0]).toMatch(/self-contained/i);
		expect(captured[1]).toContain("explorer");

		rmSync(join(agentsDir, "explorer.md"));
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			["---", "description: Reviews code with great care", "---", "", "You are a careful code reviewer.", ""].join("\n"),
		);
		await session.prompt("Third prompt.");

		const latestToolDelta = capturedToolDeltas[capturedToolDeltas.length - 1];
		expect(latestToolDelta).toContain("Reviews code with great care");
		expect(latestToolDelta).not.toContain("Explores unfamiliar code");
	} finally {
		dispose();
	}
});

it("runs the subagent with the definition body on pi's default prompt, without the task tool, on the host's model", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		const agentsDir = join(cwd, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			["---", "description: Reviews code changes", "---", "", "You are a careful code reviewer.", ""].join("\n"),
		);

		let subagentSystemText = "";
		let subagentModelId = "";
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", { agent: "reviewer", task: "Review the pending changes" }),
				{ stopReason: "toolUse" },
			),
			(context, _options, _state, model) => {
				subagentSystemText = JSON.stringify(context.messages);
				subagentModelId = model.id;
				return fauxAssistantMessage("Looks good to me.");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Please have a reviewer look at the pending changes.");

		expect(subagentSystemText).toContain("You are a careful code reviewer.");
		expect(subagentSystemText).toContain("<tools>");
		expect(subagentSystemText).toContain("<rules>");
		expect(subagentSystemText).not.toContain("Delegate a task to a named subagent");
		expect(subagentModelId).toBe(faux.getModel().id);
	} finally {
		dispose();
	}
});

it("cancels a running delegation through the abort signal and stops the nested session", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		const agentsDir = join(cwd, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			["---", "description: Reviews code changes", "---", "", "You are a careful code reviewer.", ""].join("\n"),
		);

		let nestedStarted!: () => void;
		const nestedStartedPromise = new Promise<void>((resolve) => {
			nestedStarted = resolve;
		});
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", { agent: "reviewer", task: "Review the pending changes" }),
				{ stopReason: "toolUse" },
			),
			async () => {
				nestedStarted();
				await new Promise((resolve) => setTimeout(resolve, 300));
				return fauxAssistantMessage("Late reply.");
			},
			fauxAssistantMessage("Understood."),
		]);

		const promptDone = session.prompt("Please have a reviewer look at the pending changes.");
		await nestedStartedPromise;
		session.abort();
		await promptDone;

		const results = session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "task",
		) as Array<{ isError: boolean; content: Array<{ type: string; text?: string }> }>;

		const text = results.map((result) => toolResultText(result)).join("");
		expect(text).not.toContain("Late reply.");
		for (const result of results) {
			expect(result.isError).toBe(true);
			expect(toolResultText(result)).toMatch(/cancel/i);
		}
	} finally {
		dispose();
	}
});
