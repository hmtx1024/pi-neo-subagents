/**
 * Ticket 01 — execution controls.
 *
 * A delegation can be capped by turns, wall-clock time, and tokens, and can pin
 * a thinking level. Hitting a cap is a first-class outcome: the partial reply
 * comes back, the result says which budget tripped, and it is never confused
 * with a failure.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/compat";

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

function writeAgent(cwd: string, file: string, frontmatter: string[], body = "You review code."): void {
	const dir = join(cwd, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), ["---", ...frontmatter, "---", "", body, ""].join("\n"));
}

/** One assistant turn that carries text and a tool call, so the run continues. */
function turnWithToolCall(text: string, command: string) {
	return fauxAssistantMessage([fauxText(text), fauxToolCall("bash", { command })], {
		stopReason: "toolUse",
	});
}

function hostDelegation(target: string, args: Record<string, unknown> = {}) {
	return fauxAssistantMessage(fauxToolCall("task", { agent: target, task: "Do the thing.", ...args }), {
		stopReason: "toolUse",
	});
}

it("stops at the turn budget and returns the partial reply with a budget note", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer.md", ["description: Reviews code", "maxTurns: 2"]);
		faux.setResponses([
			hostDelegation("reviewer"),
			turnWithToolCall("first pass", "echo one"),
			turnWithToolCall("second pass", "echo two"),
			fauxAssistantMessage("this turn must never run"),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate the review.");

		const result = lastToolResult(session, "task");
		const text = toolResultText(result);
		expect(result.isError).toBeFalsy();
		expect(text).toContain("second pass");
		expect(text).toMatch(/budget/i);
		expect(text).toMatch(/turns?/i);
		expect(text).toContain("2");

		const details = result.details as {
			budgetStop?: { kind: string; limit: number; observed: number };
			turns?: number;
		};
		expect(details.budgetStop).toEqual({ kind: "turns", limit: 2, observed: 2 });
		expect(details.turns).toBe(2);
		// The reply is the one captured at the stop, never a later turn's output.
		expect(text).not.toContain("this turn must never run");
	} finally {
		dispose();
	}
});

it("stops at the token budget and reports the observed usage", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer.md", ["description: Reviews code", "maxTokens: 1"]);
		faux.setResponses([
			hostDelegation("reviewer"),
			turnWithToolCall("a fairly long first answer so the token estimate is non-zero", "echo one"),
			fauxAssistantMessage("never reached"),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate the review.");

		const result = lastToolResult(session, "task");
		expect(result.isError).toBeFalsy();
		const details = result.details as { budgetStop?: { kind: string; limit: number; observed: number } };
		expect(details.budgetStop?.kind).toBe("tokens");
		expect(details.budgetStop?.limit).toBe(1);
		expect(details.budgetStop?.observed).toBeGreaterThanOrEqual(1);
		expect(toolResultText(result)).toMatch(/budget/i);
	} finally {
		dispose();
	}
});

it("stops at the wall-clock timeout and still returns a result", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer.md", ["description: Reviews code", "timeoutMs: 30"]);
		faux.setResponses([
			hostDelegation("reviewer"),
			(async () => {
				await new Promise((resolve) => setTimeout(resolve, 500));
				return fauxAssistantMessage("too late");
			}) as FauxResponseFactory,
			fauxAssistantMessage("Understood."),
		]);

		const startedAt = Date.now();
		await session.prompt("Delegate the review.");
		const elapsed = Date.now() - startedAt;

		const result = lastToolResult(session, "task");
		expect(result.isError).toBeFalsy();
		const details = result.details as { budgetStop?: { kind: string; limit: number; observed: number } };
		expect(details.budgetStop?.kind).toBe("timeout");
		expect(details.budgetStop?.limit).toBe(30);
		expect(toolResultText(result)).toMatch(/budget/i);
		expect(elapsed).toBeLessThan(2_000);
	} finally {
		dispose();
	}
});

it("lets a per-call budget override the definition", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer.md", ["description: Reviews code", "maxTurns: 5"]);
		faux.setResponses([
			hostDelegation("reviewer", { maxTurns: 1 }),
			turnWithToolCall("only turn", "echo one"),
			fauxAssistantMessage("never reached"),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate the review.");

		const result = lastToolResult(session, "task");
		const details = result.details as { budgetStop?: { kind: string; limit: number; observed: number } };
		expect(details.budgetStop).toEqual({ kind: "turns", limit: 1, observed: 1 });
	} finally {
		dispose();
	}
});

it("applies the thinking level from the definition and echoes it in details", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer.md", ["description: Reviews code", "thinking: high"]);
		const reasoningSeen: Array<string | undefined> = [];
		faux.setResponses([
			hostDelegation("reviewer"),
			(context, options: SimpleStreamOptions | undefined) => {
				reasoningSeen.push(options?.reasoning);
				return fauxAssistantMessage("reviewed");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate the review.");

		const result = lastToolResult(session, "task");
		const details = result.details as { thinking?: string };
		expect(details.thinking).toBe("high");
		expect(reasoningSeen).toContain("high");
	} finally {
		dispose();
	}
});

it("leaves a definition without budgets unbounded", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer.md", ["description: Reviews code"]);
		faux.setResponses([
			hostDelegation("reviewer"),
			turnWithToolCall("one", "echo one"),
			turnWithToolCall("two", "echo two"),
			fauxAssistantMessage("final answer"),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate the review.");

		const result = lastToolResult(session, "task");
		const details = result.details as { budgetStop?: unknown; turns?: number };
		expect(details.budgetStop).toBeUndefined();
		expect(details.turns).toBe(3);
		expect(toolResultText(result)).toBe("final answer");
	} finally {
		dispose();
	}
});

it("reports invalid budget and thinking values in a definition as file-level errors", async () => {
	const { session, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "bad-turns.md", ["description: Bad turns", "maxTurns: 0"]);
		writeAgent(cwd, "bad-thinking.md", ["description: Bad thinking", "thinking: turbo"]);

		await session.prompt("/subagents");

		const errors = ui.notifications
			.filter((notification) => notification.type === "error")
			.map((notification) => notification.message)
			.join("\n");
		expect(errors).toContain("bad-turns.md");
		expect(errors).toMatch(/maxTurns/i);
		expect(errors).toContain("bad-thinking.md");
		expect(errors).toMatch(/thinking/i);
	} finally {
		dispose();
	}
});

it("rejects an invalid budget override on a call", async () => {
	const { session, faux, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer.md", ["description: Reviews code"]);
		faux.setResponses([
			hostDelegation("reviewer", { maxTurns: 0 }),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate the review.");

		const result = lastToolResult(session, "task");
		expect(result.isError).toBe(true);
		expect(toolResultText(result)).toMatch(/maxTurns/i);
		expect(userOutput(ui)).not.toMatch(/budget/i);
	} finally {
		dispose();
	}
});
