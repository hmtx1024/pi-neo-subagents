/**
 * Ticket 05 — nested system prompt slimming.
 *
 * Pi's `docs` section (a pointer to Pi's own documentation, 343 tokens) rides
 * along in every subagent request although the subagent's isolation design
 * (no extensions, no skills) means it can never need it — 62% of the nested
 * system prompt. Subagent sessions load one inline extension whose only job is
 * to drop that section from the system message; the host session keeps it
 * (Pi's own feature domain, per profiling report §7#3).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";

import { createTestSession } from "./harness.ts";

interface SystemishMessage {
	role?: string;
	content?: unknown;
	sections?: Record<string, string>;
}

function systemSections(context: TranscriptContext): Record<string, string> {
	const system = context.messages.find((message) => message.role === "system") as SystemishMessage | undefined;
	return { ...(system?.sections ?? {}) };
}

function writeAgent(root: string, name: string, frontmatter: string[] = [], body = "Body."): void {
	const dir = join(root, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.md`),
		["---", `description: The ${name} agent`, ...frontmatter, "---", "", body, ""].join("\n"),
	);
}

it("strips the pi docs pointer from a subagent's system prompt", async () => {
	const { session, faux, root, dispose } = await createTestSession();
	try {
		writeAgent(root, "editor", ["tools: read, write, bash"], "You write exactly what you are told.");
		let nested: Record<string, string> = {};

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { agent: "editor", task: "Write hello.txt" }), {
				stopReason: "toolUse",
			}),
			(context: TranscriptContext) => {
				nested = systemSections(context);
				return fauxAssistantMessage("wrote it");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate.");

		// The docs pointer is gone ...
		expect(Object.keys(nested)).not.toContain("docs");
		expect(JSON.stringify(nested)).not.toMatch(/Pi documentation/);
		// ... while everything the subagent needs stays: preamble, tool list,
		// rules, the definition body (addendum), and the cwd.
		expect(Object.keys(nested)).toContain("preamble");
		expect(Object.keys(nested)).toContain("rules");
		expect(Object.keys(nested)).toContain("addendum");
		expect(nested.addendum).toContain("You write exactly what you are told.");
		expect(Object.keys(nested)).toContain("cwd");

		const results = (session.messages as Array<{ role: string; toolName?: string; content: Array<{ type: string; text?: string }> }>).filter(
			(message) => message.role === "toolResult" && message.toolName === "task",
		);
		expect(results[results.length - 1].content.map((block) => block.text ?? "").join("")).toBe("wrote it");
	} finally {
		dispose();
	}
});

it("keeps the docs pointer in the HOST session (scope guard)", async () => {
	const { session, faux, dispose } = await createTestSession();
	try {
		let host: Record<string, string> = {};
		faux.setResponses([
			(context: TranscriptContext) => {
				host = systemSections(context);
				return fauxAssistantMessage("ok");
			},
		]);

		await session.prompt("Hello.");

		expect(Object.keys(host)).toContain("docs");
		expect(host.docs).toMatch(/Pi documentation/);
	} finally {
		dispose();
	}
});

it("leaves systemPrompt: replace definitions untouched", async () => {
	const { session, faux, root, dispose } = await createTestSession();
	try {
		writeAgent(root, "solo", ["systemPrompt: replace"], "You are a standalone specialist.");
		let nested: Record<string, string> = {};

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { agent: "solo", task: "Do it" }), { stopReason: "toolUse" }),
			(context: TranscriptContext) => {
				nested = systemSections(context);
				return fauxAssistantMessage("done");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate.");

		expect(Object.keys(nested)).not.toContain("docs");
		// The replacement body becomes the (custom) preamble; no default sections.
		expect(nested.preamble).toContain("You are a standalone specialist.");
	} finally {
		dispose();
	}
});

it("strips the docs pointer for spawning agents too, without touching recursion", async () => {
	const { session, faux, root, dispose } = await createTestSession();
	try {
		writeAgent(root, "lead", ["tools: read, task", "allowSubagents: true"]);
		let nested: Record<string, string> = {};
		let leadTools: string[] = [];

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { agent: "lead", task: "Plan it" }), { stopReason: "toolUse" }),
			(context: TranscriptContext) => {
				const system = context.messages.find((message) => message.role === "system") as
					| { toolsAdded?: Array<{ name?: string }> }
					| undefined;
				leadTools = (system?.toolsAdded ?? []).map((entry) => entry.name ?? "");
				nested = systemSections(context);
				return fauxAssistantMessage("lead replied");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate.");

		expect(Object.keys(nested)).not.toContain("docs");
		// The opt-in recursion tool still reaches the spawning agent's session.
		expect(leadTools).toContain("task");
	} finally {
		dispose();
	}
});
