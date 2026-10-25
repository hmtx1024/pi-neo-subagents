/**
 * Ticket 10 — authorization and settings.
 *
 * Project-level agents (repository-controlled prompts that can run commands) are
 * confirmed before first use; the model cannot author definitions unless
 * allowed; user-scope writes are opt-in; and non-interactive sessions follow the
 * setting instead of blocking.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

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

function writeAgent(root: string, file: string, description: string): void {
	const dir = join(root, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), ["---", `description: ${description}`, "---", "", "Body.", ""].join("\n"));
}

function writeSettings(agentDir: string, subagents: Record<string, unknown>): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ subagents }, null, 2));
}

function hostDelegation(target: string, task = "Do it.") {
	return fauxAssistantMessage(fauxToolCall("task", { agent: target, task }), { stopReason: "toolUse" });
}

it("asks once per project agent and remembers the answer", async () => {
	const { session, faux, root, dispose } = await createTestSession({ dialogs: { confirm: [true] } });
	try {
		writeAgent(root, "reviewer.md", "Reviews code changes");
		faux.setResponses([
			hostDelegation("reviewer", "first"),
			fauxAssistantMessage("first reply"),
			hostDelegation("reviewer", "second"),
			fauxAssistantMessage("second reply"),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate twice.");

		const results = (session.messages as Array<{ role: string; toolName?: string }>).filter(
			(message) => message.role === "toolResult" && message.toolName === "task",
		) as unknown as ToolResultMessage[];
		expect(results).toHaveLength(2);
		// Only one confirmation was scripted; a second prompt would have returned false.
		expect(toolResultText(results[0])).toBe("first reply");
		expect(toolResultText(results[1])).toBe("second reply");
	} finally {
		dispose();
	}
});

it("runs nothing when the confirmation is denied", async () => {
	const { session, faux, root, dispose } = await createTestSession({ dialogs: { confirm: [false] } });
	try {
		writeAgent(root, "reviewer.md", "Reviews code changes");
		const pendingBefore = faux.getPendingResponseCount();
		faux.setResponses([
			hostDelegation("reviewer"),
			fauxAssistantMessage("must not run"),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate.");

		const result = lastToolResult(session, "task");
		expect(result.isError).toBe(true);
		expect(toolResultText(result)).toMatch(/denied|declined/i);
		expect(faux.getPendingResponseCount()).toBe(pendingBefore + 1);
	} finally {
		dispose();
	}
});

it("never prompts for user-level agents or ad-hoc entries", async () => {
	const { session, faux, ui, root, agentDir, dispose } = await createTestSession();
	try {
		writeAgent(root, "project-agent.md", "Project agent");
		const userDir = join(agentDir, "agents");
		mkdirSync(userDir, { recursive: true });
		writeFileSync(
			join(userDir, "personal.md"),
			["---", "description: Personal agent", "---", "", "Body.", ""].join("\n"),
		);

		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", {
					tasks: [
						{ agent: "personal", task: "one" },
						{ instructions: "You are inline.", task: "two" },
					],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("personal reply"),
			fauxAssistantMessage("inline reply"),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate to user-level and inline agents.");

		const result = lastToolResult(session, "task");
		expect(result.isError).toBeFalsy();
		expect(toolResultText(result)).toContain("personal reply");
		expect(toolResultText(result)).toContain("inline reply");
		expect(ui.dialogCalls.filter((call) => call.method === "confirm")).toHaveLength(0);
	} finally {
		dispose();
	}
});

it("follows the setting instead of blocking without a UI", async () => {
	const permissive = await createTestSession({ mode: "print" });
	try {
		writeAgent(permissive.root, "reviewer.md", "Reviews code changes");
		permissive.faux.setResponses([
			hostDelegation("reviewer"),
			fauxAssistantMessage("ran without a prompt"),
			fauxAssistantMessage("Understood."),
		]);

		await permissive.session.prompt("Delegate.");
		// Default "ask" with no UI: proceed, never hang, and the delegation completes.
		const result = lastToolResult(permissive.session, "task");
		expect(result.isError).toBeFalsy();
		expect(toolResultText(result)).toBe("ran without a prompt");
	} finally {
		permissive.dispose();
	}

	const strict = await createTestSession({
		mode: "print",
		setup: ({ agentDir }) => writeSettings(agentDir, { confirmProjectAgents: "deny" }),
	});
	try {
		writeAgent(strict.root, "reviewer.md", "Reviews code changes");
		strict.faux.setResponses([hostDelegation("reviewer"), fauxAssistantMessage("would run")]);

		await strict.session.prompt("Delegate.");

		const result = lastToolResult(strict.session, "task");
		expect(result.isError).toBe(true);
		expect(toolResultText(result)).toMatch(/confirmation|denied|no ui/i);
	} finally {
		strict.dispose();
	}
});

it("refuses model-created definitions when the setting disables them", async () => {
	const { session, faux, root, dispose } = await createTestSession({
		setup: ({ agentDir }) => writeSettings(agentDir, { allowModelCreatedDefinitions: false }),
	});
	try {
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("create_subagent", {
					name: "sneaky",
					description: "Created by the model",
					instructions: "Body.",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Create a definition.");

		const result = lastToolResult(session, "create_subagent");
		expect(result.isError).toBe(true);
		expect(toolResultText(result)).toMatch(/allowModelCreatedDefinitions|disabled/i);
		expect(existsSync(join(root, ".pi", "agents", "sneaky.md"))).toBe(false);
	} finally {
		dispose();
	}
});

it("refuses user-scope creation unless it is allowed", async () => {
	const { session, faux, agentDir, dispose } = await createTestSession();
	try {
		const create = fauxToolCall("create_subagent", {
			name: "shared",
			description: "Shared agent",
			instructions: "Body.",
			scope: "user",
		});
		faux.setResponses([
			fauxAssistantMessage(create, { stopReason: "toolUse" }),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Create a user-level definition.");

		const result = lastToolResult(session, "create_subagent");
		expect(result.isError).toBe(true);
		expect(toolResultText(result)).toMatch(/allowUserScopeCreation|user scope/i);
		expect(existsSync(join(agentDir, "agents", "shared.md"))).toBe(false);
	} finally {
		dispose();
	}
});

it("does not leak confirmations across sessions", async () => {
	const first = await createTestSession({ dialogs: { confirm: [true] } });
	try {
		writeAgent(first.root, "reviewer.md", "Reviews code changes");
		first.faux.setResponses([hostDelegation("reviewer"), fauxAssistantMessage("one"), fauxAssistantMessage("ok")]);
		await first.session.prompt("Delegate.");
	} finally {
		first.dispose();
	}

	const second = await createTestSession({ dialogs: { confirm: [true] } });
	try {
		writeAgent(second.root, "reviewer.md", "Reviews code changes");
		second.faux.setResponses([hostDelegation("reviewer"), fauxAssistantMessage("two"), fauxAssistantMessage("ok")]);
		await second.session.prompt("Delegate.");

		const result = lastToolResult(second.session, "task");
		expect(result.isError).toBeFalsy();
		expect(toolResultText(result)).toBe("two");
	} finally {
		second.dispose();
	}
});
