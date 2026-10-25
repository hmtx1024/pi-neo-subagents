/**
 * Ticket 04 — chained dispatch.
 *
 * A call may run steps in order, each able to consume the previous step's reply
 * through `{previous}`. The chain stops at the first step that does not complete
 * and reports what ran, what failed, and what was skipped.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/compat";

import { createTestSession, toolResultText } from "./harness.ts";

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

function writeAgent(cwd: string, name: string, description: string): void {
	const dir = join(cwd, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.md`), ["---", `description: ${description}`, "---", "", "Body.", ""].join("\n"));
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

function chainCall(steps: Array<{ agent: string; task: string; maxTurns?: number }>) {
	return fauxAssistantMessage(fauxToolCall("task", { chain: steps }), { stopReason: "toolUse" });
}

it("runs chain steps in order and substitutes the previous reply", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer", "Reviews code");
		writeAgent(cwd, "fixer", "Applies feedback");

		const seen: string[] = [];
		const step: FauxResponseFactory = (context) => {
			const task = taskTextOf(context);
			seen.push(task);
			return fauxAssistantMessage(task.startsWith("review") ? "draft reply" : "fixed reply");
		};

		faux.setResponses([
			chainCall([
				{ agent: "reviewer", task: "review the draft" },
				{ agent: "fixer", task: "apply this feedback: {previous}" },
			]),
			step,
			step,
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Run the pipeline.");

		const result = lastToolResult(session, "task");
		const text = toolResultText(result);
		expect(result.isError).toBeFalsy();
		expect(seen).toEqual(["review the draft", "apply this feedback: draft reply"]);
		expect(text).toContain("draft reply");
		expect(text).toContain("fixed reply");
		expect(text.indexOf("draft reply")).toBeLessThan(text.indexOf("fixed reply"));
	} finally {
		dispose();
	}
});

it("rejects {previous} in the first step before running anything", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer", "Reviews code");
		const pendingBefore = faux.getPendingResponseCount();
		faux.setResponses([
			chainCall([{ agent: "reviewer", task: "use {previous} here" }]),
			fauxAssistantMessage("Understood."),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Run the pipeline.");

		const result = lastToolResult(session, "task");
		const text = toolResultText(result);
		expect(result.isError).toBe(true);
		expect(text).toMatch(/\{previous\}/);
		expect(text).toMatch(/first step/i);
		// Nothing ran: only the scripted host replies remain pending.
		expect(faux.getPendingResponseCount()).toBe(pendingBefore + 1);
	} finally {
		dispose();
	}
});

it("stops at the first step that fails and reports ran, failed, and skipped", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer", "Reviews code");
		writeAgent(cwd, "verifier", "Verifies work");
		const step: FauxResponseFactory = (context) => fauxAssistantMessage(`reply for ${taskTextOf(context)}`);

		faux.setResponses([
			chainCall([
				{ agent: "reviewer", task: "step one" },
				{ agent: "ghost", task: "step two" },
				{ agent: "verifier", task: "step three" },
			]),
			step,
			step,
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Run the pipeline.");

		const result = lastToolResult(session, "task");
		const text = toolResultText(result);
		expect(text).toContain("reply for step one");
		expect(text).toContain('No agent definition named "ghost"');
		expect(text).not.toContain("reply for step three");
		expect(text).toMatch(/skipped/i);

		const steps = (result.details as { steps?: Array<{ agent: string; status: string }> }).steps;
		expect(steps?.map((entry) => entry.status)).toEqual(["ok", "failed", "skipped"]);
	} finally {
		dispose();
	}
});

it("runs chain steps strictly one at a time", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer", "Reviews code");
		let inFlight = 0;
		let peak = 0;
		const step: FauxResponseFactory = async (context) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 20));
			inFlight -= 1;
			return fauxAssistantMessage(`reply for ${taskTextOf(context)}`);
		};

		faux.setResponses([
			chainCall([
				{ agent: "reviewer", task: "step one" },
				{ agent: "reviewer", task: "step two {previous}" },
			]),
			step,
			step,
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Run the pipeline.");

		expect(peak).toBe(1);
		const result = lastToolResult(session, "task");
		expect(result.isError).toBeFalsy();
	} finally {
		dispose();
	}
});

it("halts the chain when a step is cut short by a budget", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer", "Reviews code");
		writeAgent(cwd, "fixer", "Applies feedback");
		faux.setResponses([
			chainCall([
				{ agent: "reviewer", task: "step one", maxTurns: 1 },
				{ agent: "fixer", task: "step two {previous}" },
			]),
			fauxAssistantMessage([fauxText("partial answer"), fauxToolCall("bash", { command: "echo one" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("never reached"),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Run the pipeline.");

		const result = lastToolResult(session, "task");
		const text = toolResultText(result);
		expect(text).toContain("partial answer");
		expect(text).toMatch(/budget/i);
		expect(text).toMatch(/skipped/i);
		const steps = (result.details as { steps?: Array<{ status: string }> }).steps;
		expect(steps?.map((entry) => entry.status)).toEqual(["budget-stop", "skipped"]);
	} finally {
		dispose();
	}
});

it("rejects a call that supplies both a chain and a parallel list", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer", "Reviews code");
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					chain: [{ agent: "reviewer", task: "a" }],
					tasks: [{ agent: "reviewer", task: "b" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Run the pipeline.");

		const result = lastToolResult(session, "task");
		expect(result.isError).toBe(true);
		expect(toolResultText(result)).toMatch(/exactly one/i);
		expect(toolResultText(result)).toMatch(/chain/i);
	} finally {
		dispose();
	}
});
