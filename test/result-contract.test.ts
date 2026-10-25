/**
 * Ticket 04 — result contract.
 *
 * Spec-level behaviour: delegation results protect the caller's context
 * (truncation with an on-disk full copy), carry structured details for audit,
 * report nested token usage, and emit coarse progress while running.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";

import { createTestSession, toolResultText } from "./harness.ts";

function writeReviewerDefinition(cwd: string): void {
	const agentsDir = join(cwd, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		join(agentsDir, "reviewer.md"),
		["---", "description: Reviews code changes", "---", "", "You are a careful code reviewer.", ""].join("\n"),
	);
}

it("truncates oversized results with a notice naming the on-disk full copy", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeReviewerDefinition(cwd);
		const fullReply = "A".repeat(35_000);
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", { agent: "reviewer", task: "Review the pending changes" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fullReply),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Please have a reviewer look at the pending changes.");

		const result = session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "task",
		) as { content: Array<{ type: string; text?: string }> } | undefined;

		expect(result).toBeDefined();
		const text = toolResultText(result!);
		expect(text.length).toBeLessThan(fullReply.length);
		expect(text).toMatch(/truncated/i);
		const match = text.match(/Full result: (.+?)\]/);
		expect(match).not.toBeNull();
		expect(readFileSync(match![1].trim(), "utf-8")).toBe(fullReply);
	} finally {
		dispose();
	}
});

it("carries structured details (turns, usage, model, task, duration) with the tool result", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeReviewerDefinition(cwd);
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", { agent: "reviewer", task: "Review the pending changes" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Looks good to me."),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Please have a reviewer look at the pending changes.");

		const result = session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "task",
		) as { details?: Record<string, unknown> } | undefined;

		expect(result).toBeDefined();
		const details = result!.details!;
		expect(details.task).toBe("Review the pending changes");
		expect(details.model).toBe(faux.getModel().id);
		expect(details.turns as number).toBeGreaterThanOrEqual(1);
		expect(typeof details.durationMs).toBe("number");
		const usage = details.usage as { totalTokens: number };
		expect(usage.totalTokens).toBeGreaterThan(0);
	} finally {
		dispose();
	}
});

it("reports the subagent's token usage on the tool result so session totals stay accurate", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeReviewerDefinition(cwd);
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", { agent: "reviewer", task: "Review the pending changes" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Looks good to me."),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Please have a reviewer look at the pending changes.");

		const result = session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "task",
		) as { usage?: { totalTokens: number } } | undefined;

		expect(result).toBeDefined();
		expect(result!.usage!.totalTokens).toBeGreaterThan(0);
	} finally {
		dispose();
	}
});

it("emits coarse progress updates while the subagent runs", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeReviewerDefinition(cwd);
		const updates: unknown[] = [];
		session.subscribe((event) => {
			if (event.type === "tool_execution_update" && event.toolName === "task") {
				updates.push(event.partialResult);
			}
		});
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", { agent: "reviewer", task: "Review the pending changes" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Looks good to me."),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Please have a reviewer look at the pending changes.");

		expect(updates.length).toBeGreaterThanOrEqual(1);
		expect(JSON.stringify(updates)).toMatch(/turn/i);
	} finally {
		dispose();
	}
});
