/**
 * Ticket 07 — strict definition validation.
 *
 * Definition mistakes fail loudly: a `systemPrompt` value that does nothing, a
 * tool that does not exist, an unresolvable model, or an invalid budget is an
 * error naming the offending field, never a silent fallback.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";

import { createTestSession, toolResultText, userOutput } from "./harness.ts";

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

function writeAgent(cwd: string, file: string, frontmatter: string[]): void {
	const dir = join(cwd, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), ["---", ...frontmatter, "---", "", "Body.", ""].join("\n"));
}

function creationCall(args: {
	name: string;
	description: string;
	instructions: string;
	tools?: string[];
	model?: string;
	maxTurns?: number;
	thinking?: string;
}) {
	return fauxAssistantMessage(fauxToolCall("create_subagent", args), { stopReason: "toolUse" });
}

it("reports a systemPrompt value other than replace as a file-level error", async () => {
	const { session, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "half-replaced.md", ["description: Half replaced", "systemPrompt: append"]);
		writeAgent(cwd, "plain.md", ["description: Plain definition"]);

		await session.prompt("/subagents");

		const errors = ui.notifications
			.filter((notification) => notification.type === "error")
			.map((notification) => notification.message)
			.join("\n");
		expect(errors).toContain("half-replaced.md");
		expect(errors).toMatch(/systemPrompt/);
		expect(errors).toMatch(/replace/);

		// An omitted systemPrompt still means append, and still loads.
		expect(userOutput(ui)).toContain("- plain — Plain definition");
	} finally {
		dispose();
	}
});

it("stays lenient about tool names at discovery time", async () => {
	const { session, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "future-tools.md", ["description: Uses a tool from another session", "tools: read, telepathy"]);

		await session.prompt("/subagents");

		expect(ui.notifications.filter((notification) => notification.type === "error")).toHaveLength(0);
		expect(userOutput(ui)).toContain("- future-tools — Uses a tool from another session");
	} finally {
		dispose();
	}
});

it("rejects a created definition that names a tool which does not exist", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		faux.setResponses([
			creationCall({
				name: "telepath",
				description: "Reads minds",
				instructions: "You read minds.",
				tools: ["read", "telepathy"],
			}),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Create a definition with a bad tool.");

		const result = lastToolResult(session, "create_subagent");
		expect(result.isError).toBe(true);
		expect(toolResultText(result)).toContain("telepathy");
		expect(existsSync(join(cwd, ".pi", "agents", "telepath.md"))).toBe(false);
	} finally {
		dispose();
	}
});

it("rejects giving an agent the task tool", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		faux.setResponses([
			creationCall({
				name: "recursive",
				description: "Tries to delegate",
				instructions: "Delegate everything.",
				tools: ["read", "task"],
			}),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Create a recursive definition.");

		const result = lastToolResult(session, "create_subagent");
		expect(result.isError).toBe(true);
		expect(toolResultText(result)).toMatch(/task/);
		expect(toolResultText(result)).toMatch(/delegate|recurs/i);
		expect(existsSync(join(cwd, ".pi", "agents", "recursive.md"))).toBe(false);
	} finally {
		dispose();
	}
});

it("rejects a created definition that pins an unresolvable model", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		faux.setResponses([
			creationCall({
				name: "ghost-model",
				description: "Uses a missing model",
				instructions: "You run nowhere.",
				model: "nowhere/model",
			}),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Create a definition with a bad model.");

		const result = lastToolResult(session, "create_subagent");
		expect(result.isError).toBe(true);
		expect(toolResultText(result)).toContain("nowhere/model");
		expect(existsSync(join(cwd, ".pi", "agents", "ghost-model.md"))).toBe(false);
	} finally {
		dispose();
	}
});

it("rejects invalid budget and thinking values at creation", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		faux.setResponses([
			creationCall({
				name: "bad-turn",
				description: "Bad turn budget",
				instructions: "Body.",
				maxTurns: 0,
			}),
			creationCall({
				name: "bad-thinking",
				description: "Bad thinking level",
				instructions: "Body.",
				thinking: "turbo",
			}),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Create invalid definitions.");

		const results = (session.messages as Array<{ role: string; toolName?: string }>).filter(
			(message) => message.role === "toolResult" && message.toolName === "create_subagent",
		) as unknown as ToolResultMessage[];
		expect(results).toHaveLength(2);
		expect(results[0].isError).toBe(true);
		expect(toolResultText(results[0])).toMatch(/maxTurns/);
		expect(results[1].isError).toBe(true);
		expect(toolResultText(results[1])).toMatch(/thinking/);
		expect(existsSync(join(cwd, ".pi", "agents", "bad-turn.md"))).toBe(false);
	} finally {
		dispose();
	}
});
