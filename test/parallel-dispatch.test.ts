/**
 * Ticket 03 — parallel dispatch.
 *
 * One `task` call can fan out: tasks run concurrently under a cap, results come
 * back in submission order, one failure does not cancel its siblings, and
 * cancelling the call cancels everything in flight.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/compat";

import { createTestSession, toolResultText } from "./harness.ts";

const CONCURRENCY_ENV = "PI_NEO_SUBAGENTS_MAX_CONCURRENCY";

afterEach(() => {
	delete process.env[CONCURRENCY_ENV];
});

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

/** The task text a nested session received — its first user message. */
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

/** Reply per task, so identity never depends on call order. */
const echoTask: FauxResponseFactory = (context) => fauxAssistantMessage(`reply for ${taskTextOf(context)}`);

function dispatchCall(tasks: Array<{ agent: string; task: string }>, extra: Record<string, unknown> = {}) {
	return fauxAssistantMessage(fauxToolCall("task", { tasks, ...extra }), { stopReason: "toolUse" });
}

it("runs several tasks concurrently and returns results in submission order", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer", "Reviews code");
		writeAgent(cwd, "scout", "Explores code");

		let releaseSlow!: () => void;
		const slowGate = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const finished: string[] = [];
		const byTask: FauxResponseFactory = async (context) => {
			const task = taskTextOf(context);
			if (task.includes("slow")) {
				await slowGate;
				finished.push(task);
				return fauxAssistantMessage(`reply for ${task}`);
			}
			finished.push(task);
			return fauxAssistantMessage(`reply for ${task}`);
		};

		faux.setResponses([dispatchCall([
			{ agent: "reviewer", task: "slow task A" },
			{ agent: "scout", task: "fast task B" },
		]), byTask, byTask, fauxAssistantMessage("Understood.")]);

		const prompt = session.prompt("Fan out.");
		// The fast task must finish while the slow one is still running.
		await vi.waitFor(() => expect(finished).toEqual(["fast task B"]), { timeout: 5_000 });
		releaseSlow();
		await prompt;

		const result = lastToolResult(session, "task");
		const text = toolResultText(result);
		expect(result.isError).toBeFalsy();
		expect(finished).toEqual(["fast task B", "slow task A"]);
		expect(text.indexOf("reply for slow task A")).toBeGreaterThanOrEqual(0);
		expect(text.indexOf("reply for slow task A")).toBeLessThan(text.indexOf("reply for fast task B"));
	} finally {
		dispose();
	}
});

it("never exceeds the configured concurrency and still runs every task", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		process.env[CONCURRENCY_ENV] = "2";
		writeAgent(cwd, "scout", "Explores code");

		let inFlight = 0;
		let peak = 0;
		let calls = 0;
		const slow: FauxResponseFactory = async (context) => {
			inFlight += 1;
			calls += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 25));
			inFlight -= 1;
			return fauxAssistantMessage(`reply for ${taskTextOf(context)}`);
		};

		const tasks = Array.from({ length: 5 }, (_, index) => ({ agent: "scout", task: `task ${index}` }));
		faux.setResponses([
			dispatchCall(tasks),
			slow,
			slow,
			slow,
			slow,
			slow,
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Fan out.");

		const result = lastToolResult(session, "task");
		const text = toolResultText(result);
		expect(result.isError).toBeFalsy();
		expect(peak).toBe(2);
		expect(calls).toBe(5);
		for (let index = 0; index < 5; index += 1) {
			expect(text).toContain(`reply for task ${index}`);
		}
	} finally {
		dispose();
	}
});

it("keeps running when one task fails and reports that task as failed", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer", "Reviews code");
		writeAgent(cwd, "scout", "Explores code");
		faux.setResponses([
			dispatchCall([
				{ agent: "reviewer", task: "task one" },
				{ agent: "ghost", task: "task two" },
				{ agent: "scout", task: "task three" },
			]),
			echoTask,
			echoTask,
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Fan out.");

		const result = lastToolResult(session, "task");
		const text = toolResultText(result);
		expect(result.isError).toBeFalsy();
		expect(text).toContain("reply for task one");
		expect(text).toContain("reply for task three");
		expect(text).toContain('No agent definition named "ghost"');

		const outcomes = (result.details as { tasks?: Array<{ agent: string; status: string }> }).tasks;
		expect(outcomes?.map((outcome) => outcome.status)).toEqual(["ok", "failed", "ok"]);
	} finally {
		dispose();
	}
});

it("reports an error only when every task failed", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer", "Reviews code");
		faux.setResponses([
			dispatchCall([
				{ agent: "ghost-one", task: "a" },
				{ agent: "ghost-two", task: "b" },
			]),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Fan out.");

		const result = lastToolResult(session, "task");
		const text = toolResultText(result);
		expect(result.isError).toBe(true);
		expect(text).toContain("ghost-one");
		expect(text).toContain("ghost-two");
	} finally {
		dispose();
	}
});

it("rejects a call with no dispatch shape or with two shapes", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer", "Reviews code");
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall("task", {
					agent: "reviewer",
					task: "single",
					tasks: [{ agent: "reviewer", task: "parallel" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Try invalid shapes.");

		const results = (session.messages as Array<{ role: string; toolName?: string }>).filter(
			(message) => message.role === "toolResult" && message.toolName === "task",
		) as unknown as ToolResultMessage[];
		expect(results).toHaveLength(2);
		for (const result of results) {
			expect(result.isError).toBe(true);
			expect(toolResultText(result)).toMatch(/exactly one|provide/i);
			expect(toolResultText(result)).toMatch(/tasks/i);
		}
	} finally {
		dispose();
	}
});

it("cancels every in-flight task when the call is aborted", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer", "Reviews code");
		const never: FauxResponseFactory = async () => {
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			return fauxAssistantMessage("too late");
		};
		faux.setResponses([
			dispatchCall([
				{ agent: "reviewer", task: "task one" },
				{ agent: "reviewer", task: "task two" },
			]),
			never,
			never,
			fauxAssistantMessage("Understood."),
		]);

		const prompt = session.prompt("Fan out.");
		await new Promise((resolve) => setTimeout(resolve, 80));
		session.abort();
		await prompt;

		const result = lastToolResult(session, "task");
		const text = toolResultText(result);
		expect(result.isError).toBe(true);
		expect(text.match(/cancel/gi)?.length ?? 0).toBeGreaterThanOrEqual(2);
	} finally {
		dispose();
	}
});

it("reports progress that identifies each in-flight task", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer", "Reviews code");
		writeAgent(cwd, "scout", "Explores code");
		const updates: string[] = [];
		session.subscribe((event) => {
			if (event.type === "tool_execution_update" && event.toolName === "task") {
				const partial = event.partialResult as { content?: Array<{ type: string; text?: string }> };
				const text = (partial.content ?? [])
					.filter((block) => block.type === "text")
					.map((block) => block.text ?? "")
					.join("");
				if (text !== "") updates.push(text);
			}
		});
		const withToolCall: FauxResponseFactory = (context) =>
			fauxAssistantMessage(`reply for ${taskTextOf(context)}`);

		faux.setResponses([
			dispatchCall([
				{ agent: "reviewer", task: "task one" },
				{ agent: "scout", task: "task two" },
			]),
			withToolCall,
			withToolCall,
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Fan out.");

		const joined = updates.join("\n");
		expect(joined).toMatch(/1\/2/);
		expect(joined).toMatch(/2\/2/);
	} finally {
		dispose();
	}
});
