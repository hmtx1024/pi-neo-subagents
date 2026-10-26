/**
 * Ticket 01 — default execution budgets.
 *
 * A delegated run with no explicit budget used to be unbounded: a runaway
 * model loop or a hung command (pi's bash has no kill timer without an explicit
 * `timeout`) blocked the dispatch forever. Defaults now apply whenever neither
 * the call nor the definition sets a value, and `0` in settings disables a cap.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";

import { createTestSession, toolResultText, userOutput } from "./harness.ts";
import { DEFAULT_SUBAGENT_SETTINGS } from "../src/settings.ts";

interface ToolResultMessage {
	isError?: boolean;
	details?: Record<string, unknown>;
	content: Array<{ type: string; text?: string }>;
}

function lastToolResult(session: { messages: unknown[] }, toolName: string): ToolResultMessage {
	const results = (session.messages as Array<{ role: string; toolName?: string }>).filter(
		(message) => message.role === "toolResult" && message.toolName === toolName,
	);
	return results[results.length - 1] as unknown as ToolResultMessage;
}

function writeSettings(agentDir: string, subagents: Record<string, unknown>): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ subagents }));
}

function writeAgent(root: string, name: string, frontmatter: string[] = []): void {
	const dir = join(root, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.md`), ["---", `description: The ${name} agent`, ...frontmatter, "---", "", "Body.", ""].join("\n"));
}

function adHocCall(task: string) {
	return fauxAssistantMessage(
		fauxToolCall("task", { instructions: "You are a worker.", task }),
		{ stopReason: "toolUse" },
	);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

it("defaults to a ten-minute wall-clock watchdog (real research needs it)", () => {
	expect(DEFAULT_SUBAGENT_SETTINGS.defaultTimeoutMs).toBe(600_000);
	expect(DEFAULT_SUBAGENT_SETTINGS.defaultMaxTurns).toBe(50);
});

it("stops a runaway delegation at the default turn budget", async () => {
	const { session, faux, ui, dispose } = await createTestSession();
	try {
		const responses: Parameters<typeof faux.setResponses>[0] = [adHocCall("Run many steps")];
		for (let index = 0; index < 50; index += 1) {
			responses.push(
				fauxAssistantMessage([fauxText(`step ${index}`), fauxToolCall("read", { path: "/nonexistent" })], {
					stopReason: "toolUse",
				}),
			);
		}
		responses.push(fauxAssistantMessage("never seen"));
		responses.push(fauxAssistantMessage("Understood."));
		faux.setResponses(responses);

		await session.prompt("Delegate.");

		const result = lastToolResult(session, "task");
		expect(result.isError).toBeFalsy();

		const details = result.details as {
			turns: number;
			budgetStop?: { kind: string; limit: number; observed: number };
		};
		expect(details.budgetStop).toEqual({ kind: "turns", limit: 50, observed: 50 });
		expect(details.turns).toBe(50);

		// Non-fatal: partial reply plus an explicit stop notice, never an error.
		const text = toolResultText(result);
		expect(text).toMatch(/budget stop/i);
		expect(text).toContain("step 49");
		expect(text).not.toContain("never seen");

		await session.prompt("/subagents stats");
		expect(userOutput(ui)).toMatch(/budget stop/i);
	} finally {
		dispose();
	}
});

it("cuts a stuck parallel task at the default timeout instead of blocking forever", async () => {
	const { session, faux, dispose } = await createTestSession({
		setup: ({ agentDir }) => writeSettings(agentDir, { defaultTimeoutMs: 300 }),
	});
	try {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const branch = async (context: { messages: unknown[] }) => {
			const transcript = JSON.stringify(context.messages ?? []);
			if (transcript.includes("stuck")) {
				await gate;
				return fauxAssistantMessage("stuck done");
			}
			return fauxAssistantMessage("quick done");
		};

		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					tasks: [
						{ instructions: "You are a worker.", task: "a quick task about quick" },
						{ instructions: "You are a worker.", task: "a stuck task about stuck" },
					],
				}),
				{ stopReason: "toolUse" },
			),
			branch as never,
			branch as never,
			fauxAssistantMessage("Understood."),
		]);

		const prompt = session.prompt("Delegate two.");
		// The default timeout fires while the stuck response is still gated.
		await delay(600);
		release();
		await prompt;

		const result = lastToolResult(session, "task");
		expect(result.isError).toBeFalsy();

		const tasks = (result.details as {
			tasks: Array<{ agent: string; status: string; details?: { budgetStop?: { kind: string; limit: number } } }>;
		}).tasks;
		expect(tasks).toHaveLength(2);

		const quick = tasks.find((task) => task.status !== "budget-stop")!;
		const stuck = tasks.find((task) => task.status === "budget-stop")!;
		expect(stuck.details?.budgetStop?.kind).toBe("timeout");
		expect(stuck.details?.budgetStop?.limit).toBe(300);
		expect(quick.status).toBe("ok");

		const text = toolResultText(result);
		expect(text).toContain("quick done");
		// The stuck task is reported as a budget stop, not as a failure.
		expect(text).toMatch(/budget stop/i);
	} finally {
		dispose();
	}
});

it("treats zero in settings as unlimited", async () => {
	const { session, faux, dispose } = await createTestSession({
		setup: ({ agentDir }) => writeSettings(agentDir, { defaultMaxTurns: 0, defaultTimeoutMs: 0 }),
	});
	try {
		const responses: Parameters<typeof faux.setResponses>[0] = [adHocCall("Run steps")];
		for (let index = 0; index < 11; index += 1) {
			responses.push(
				fauxAssistantMessage([fauxText(`step ${index}`), fauxToolCall("read", { path: "/nonexistent" })], {
					stopReason: "toolUse",
				}),
			);
		}
		responses.push(fauxAssistantMessage("finished all"));
		responses.push(fauxAssistantMessage("Understood."));
		faux.setResponses(responses);

		await session.prompt("Delegate.");

		const details = lastToolResult(session, "task").details as {
			turns: number;
			budgetStop?: unknown;
		};
		expect(details.turns).toBe(12);
		expect(details.budgetStop).toBeUndefined();
	} finally {
		dispose();
	}
});

it("lets an explicit definition budget beat the settings default", async () => {
	const { session, faux, root, dispose } = await createTestSession({
		setup: ({ agentDir }) => writeSettings(agentDir, { defaultMaxTurns: 3 }),
	});
	try {
		writeAgent(root, "planner", ["maxTurns: 20"]);
		const responses: Parameters<typeof faux.setResponses>[0] = [
			fauxAssistantMessage(fauxToolCall("task", { agent: "planner", task: "Plan it" }), { stopReason: "toolUse" }),
		];
		for (let index = 0; index < 7; index += 1) {
			responses.push(
				fauxAssistantMessage([fauxText(`step ${index}`), fauxToolCall("read", { path: "/nonexistent" })], {
					stopReason: "toolUse",
				}),
			);
		}
		responses.push(fauxAssistantMessage("planned"));
		responses.push(fauxAssistantMessage("Understood."));
		faux.setResponses(responses);

		await session.prompt("Delegate.");

		const details = lastToolResult(session, "task").details as {
			turns: number;
			budgetStop?: unknown;
		};
		expect(details.turns).toBe(8);
		expect(details.budgetStop).toBeUndefined();
	} finally {
		dispose();
	}
});

it("falls back to the defaults when a setting is invalid", async () => {
	const { session, faux, dispose } = await createTestSession({
		setup: ({ agentDir }) => writeSettings(agentDir, { defaultMaxTurns: -5, defaultTimeoutMs: "soon" }),
	});
	try {
		const responses: Parameters<typeof faux.setResponses>[0] = [adHocCall("Run steps")];
		for (let index = 0; index < 5; index += 1) {
			responses.push(
				fauxAssistantMessage([fauxText(`step ${index}`), fauxToolCall("read", { path: "/nonexistent" })], {
					stopReason: "toolUse",
				}),
			);
		}
		responses.push(fauxAssistantMessage("done"));
		responses.push(fauxAssistantMessage("Understood."));
		faux.setResponses(responses);

		await session.prompt("Delegate.");

		// Invalid values fall back to 50/5min: a 6-turn run completes untouched.
		const details = lastToolResult(session, "task").details as {
			turns: number;
			budgetStop?: unknown;
		};
		expect(details.turns).toBe(6);
		expect(details.budgetStop).toBeUndefined();
	} finally {
		dispose();
	}
});
