/**
 * Ticket 09 — definition creation.
 *
 * A zero-definition session must not be a dead end: the model creates a
 * definition through one tool call, and by default it lands in the project
 * directory so it travels with the repository.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import type { TranscriptContext } from "@earendil-works/pi-ai";
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

it("creates a definition in the project directory and delegates to it immediately", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("create_subagent", {
					name: "python-dev",
					description: "Writes small Python programs",
					instructions: "You write idiomatic Python 3 programs.",
					tools: ["read", "write"],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("task", { agent: "python-dev", task: "Write hello.py" }),
				{ stopReason: "toolUse" },
			),
			(_context) => fauxAssistantMessage("Wrote hello.py."),
			fauxAssistantMessage("Done."),
		]);

		await session.prompt("Write a python hello world using a subagent.");

		const created = join(cwd, ".pi", "agents", "python-dev.md");
		expect(existsSync(created)).toBe(true);
		const content = readFileSync(created, "utf-8");
		expect(content).toContain("description: Writes small Python programs");
		expect(content).toContain("tools: read, write");
		expect(content).toContain("You write idiomatic Python 3 programs.");

		const createResult = lastToolResult(session, "create_subagent");
		expect(createResult.isError).toBeFalsy();
		expect(toolResultText(createResult)).toContain(created);

		// Same session, no reload: the definition is delegable right away.
		const taskResult = lastToolResult(session, "task");
		expect(taskResult.isError).toBeFalsy();
		expect(toolResultText(taskResult)).toBe("Wrote hello.py.");
	} finally {
		dispose();
	}
});

it("writes to the user scope only when explicitly asked and allowed", async () => {
	const { session, faux, cwd, agentDir, dispose } = await createTestSession({
		// User-scope writes are off by default (ticket 10); this test covers the opted-in path.
		setup: ({ agentDir: dir }) =>
			writeFileSync(join(dir, "settings.json"), JSON.stringify({ subagents: { allowUserScopeCreation: true } })),
	});
	try {
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("create_subagent", {
					name: "shared-reviewer",
					description: "Reviews code",
					instructions: "You review code.",
					scope: "user",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Done."),
		]);

		await session.prompt("Create a shared reviewer agent.");

		expect(existsSync(join(agentDir, "agents", "shared-reviewer.md"))).toBe(true);
		expect(existsSync(join(cwd, ".pi", "agents", "shared-reviewer.md"))).toBe(false);
		const text = toolResultText(lastToolResult(session, "create_subagent"));
		expect(text).toMatch(/user/i);
	} finally {
		dispose();
	}
});

it("refuses to overwrite an existing definition", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		const agentsDir = join(cwd, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		const existing = join(agentsDir, "python-dev.md");
		writeFileSync(
			existing,
			["---", "description: Hand-written definition", "---", "", "Keep me.", ""].join("\n"),
		);

		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("create_subagent", {
					name: "python-dev",
					description: "Replacement definition",
					instructions: "Replace it.",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Create python-dev.");

		const result = lastToolResult(session, "create_subagent");
		expect(result.isError).toBe(true);
		expect(toolResultText(result)).toMatch(/exists/i);
		expect(readFileSync(existing, "utf-8")).toContain("Keep me.");
	} finally {
		dispose();
	}
});

it("rejects a name that would escape the agents directory", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("create_subagent", {
					name: "../escaped",
					description: "Escapes the directory",
					instructions: "Should never be written.",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Create an agent.");

		const result = lastToolResult(session, "create_subagent");
		expect(result.isError).toBe(true);
		expect(existsSync(join(cwd, ".pi", "escaped.md"))).toBe(false);
		expect(existsSync(join(cwd, ".pi", "agents", "escaped.md"))).toBe(false);
	} finally {
		dispose();
	}
});

it("tells the model where definitions live and how to create one", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
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

		// System messages are captured as JSON, which escapes Windows path separators.
		const flatten = (text: string) => text.split("\\\\").join("/").split("\\").join("/");
		const description = flatten(captured.join("\n"));
		expect(description).toContain(flatten(join(cwd, ".pi", "agents")));
		expect(description).toContain("create_subagent");
		expect(description).toMatch(/project/i);
		expect(description).toMatch(/tasks/i);
		expect(description).toMatch(/concurrent/i);
	} finally {
		dispose();
	}
});
