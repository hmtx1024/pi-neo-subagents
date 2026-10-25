/**
 * Ticket 08 — discovery and listing fidelity.
 *
 * Definitions belong to the repository, not to the exact directory Pi was
 * started in: discovery walks up to the nearest agent directory, creation
 * targets the same place, and the listing says which file a definition came
 * from and when it changed.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";

import { createTestSession, toolResultText, userOutput } from "./harness.ts";

function writeAgent(root: string, file: string, description: string): void {
	const dir = join(root, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), ["---", `description: ${description}`, "---", "", "Body.", ""].join("\n"));
}

it("finds the repository's definitions from a nested working directory", async () => {
	const { session, ui, root, dispose } = await createTestSession({ subdir: join("packages", "app") });
	try {
		writeAgent(root, "reviewer.md", "Reviews code changes");

		await session.prompt("/subagents");

		expect(userOutput(ui)).toContain("- reviewer — Reviews code changes");
	} finally {
		dispose();
	}
});

it("lists each definition's source file and modification time", async () => {
	const { session, ui, root, dispose } = await createTestSession();
	try {
		writeAgent(root, "reviewer.md", "Reviews code changes");

		await session.prompt("/subagents");

		const output = userOutput(ui);
		expect(output).toContain("reviewer.md");
		expect(output).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
	} finally {
		dispose();
	}
});

it("creates definitions in the nearest ancestor directory, not the working directory", async () => {
	const { session, faux, root, cwd, dispose } = await createTestSession({ subdir: join("packages", "app") });
	try {
		writeAgent(root, "reviewer.md", "Reviews code changes");
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("create_subagent", {
					name: "scout",
					description: "Explores code",
					instructions: "You explore code.",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Create a scout agent.");

		expect(existsSync(join(root, ".pi", "agents", "scout.md"))).toBe(true);
		expect(existsSync(join(cwd, ".pi", "agents", "scout.md"))).toBe(false);
		const results = (session.messages as Array<{ role: string; toolName?: string }>).filter(
			(message) => message.role === "toolResult" && message.toolName === "create_subagent",
		) as unknown as Array<{ content: Array<{ type: string; text?: string }> }>;
		expect(toolResultText(results[results.length - 1])).toContain(join(root, ".pi", "agents"));
	} finally {
		dispose();
	}
});

it("falls back to the working directory when no ancestor has definitions", async () => {
	const { session, faux, cwd, dispose } = await createTestSession({ subdir: join("work", "here") });
	try {
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("create_subagent", {
					name: "fresh",
					description: "First definition here",
					instructions: "You are new.",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Create the first agent.");

		expect(existsSync(join(cwd, ".pi", "agents", "fresh.md"))).toBe(true);
	} finally {
		dispose();
	}
});
