/**
 * Ticket 07 — hardening & packaging.
 *
 * Spec-level behaviour: cancellation and teardown are clean and leave the
 * session healthy; delegation behaves identically in non-interactive modes;
 * the package installs and loads as a standard extension.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";

import { captureStdio, createTestSession, toolResultText } from "./harness.ts";

function writeReviewerDefinition(cwd: string): void {
	const agentsDir = join(cwd, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		join(agentsDir, "reviewer.md"),
		["---", "description: Reviews code changes", "---", "", "You are a careful code reviewer.", ""].join("\n"),
	);
}

it("surfaces a clean cancellation and leaves the session ready for the next delegation", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeReviewerDefinition(cwd);

		let firstNestedStarted!: () => void;
		const firstNestedStartedPromise = new Promise<void>((resolve) => {
			firstNestedStarted = resolve;
		});
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", { agent: "reviewer", task: "Review the pending changes" }),
				{ stopReason: "toolUse" },
			),
			async () => {
				firstNestedStarted();
				await new Promise((resolve) => setTimeout(resolve, 300));
				return fauxAssistantMessage("Late reply.");
			},
			fauxAssistantMessage(
				fauxToolCall("task", { agent: "reviewer", task: "Review something else" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Second reply."),
			fauxAssistantMessage("Understood."),
		]);

		const promptDone = session.prompt("First delegation.");
		await firstNestedStartedPromise;
		session.abort();
		await promptDone;

		const firstResults = session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "task",
		) as Array<{ isError: boolean; content: Array<{ type: string; text?: string }> }>;
		for (const result of firstResults) {
			expect(result.isError).toBe(true);
			expect(toolResultText(result)).toMatch(/cancel/i);
		}

		await session.prompt("Second delegation.");

		const allResults = session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "task",
		) as Array<{ content: Array<{ type: string; text?: string }> }>;
		expect(toolResultText(allResults[allResults.length - 1])).toBe("Second reply.");
	} finally {
		dispose();
	}
});

it("tears down cleanly when the host session is disposed mid-delegation", async () => {
	const first = await createTestSession();
	writeReviewerDefinition(first.cwd);
	let nestedStarted!: () => void;
	const nestedStartedPromise = new Promise<void>((resolve) => {
		nestedStarted = resolve;
	});
	first.faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("task", { agent: "reviewer", task: "Review the pending changes" }),
			{ stopReason: "toolUse" },
		),
		async () => {
			nestedStarted();
			await new Promise((resolve) => setTimeout(resolve, 300));
			return fauxAssistantMessage("Late reply.");
		},
	]);

	const promptDone = first.session.prompt("Delegation.");
	await nestedStartedPromise;
	first.dispose();
	first.dispose(); // cleanup is idempotent

	const settled = await Promise.race([
		promptDone.then(
			() => "settled",
			() => "settled",
		),
		new Promise((resolve) => setTimeout(() => resolve("hung"), 3_000)),
	]);
	expect(settled).toBe("settled");

	// A fresh session works normally afterwards: nothing global leaked.
	const second = await createTestSession();
	try {
		writeReviewerDefinition(second.cwd);
		second.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", { agent: "reviewer", task: "Review something else" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Fresh reply."),
			fauxAssistantMessage("Understood."),
		]);
		await second.session.prompt("Delegation.");
		const results = second.session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "task",
		) as Array<{ content: Array<{ type: string; text?: string }> }>;
		expect(toolResultText(results[results.length - 1])).toBe("Fresh reply.");
	} finally {
		second.dispose();
	}
});

it("keeps delegation and /subagents behaviour intact in non-interactive modes", async () => {
	const stdio = captureStdio();
	const { session, faux, cwd, dispose } = await createTestSession({ mode: "print" });
	try {
		writeReviewerDefinition(cwd);
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", { agent: "reviewer", task: "Review the pending changes" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Looks good to me."),
			fauxAssistantMessage("Understood."),
			fauxAssistantMessage("ok"),
		]);

		await session.prompt("Please have a reviewer look at the pending changes.");

		const results = session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "task",
		) as Array<{ content: Array<{ type: string; text?: string }> }>;
		expect(toolResultText(results[0])).toBe("Looks good to me.");

		await session.prompt("/subagents");
		// No UI in print mode: the listing goes to stdout instead of vanishing.
		expect(stdio.stdout()).toContain("- reviewer — Reviews code changes");
	} finally {
		dispose();
		stdio.restore();
	}
});
