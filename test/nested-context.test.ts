/**
 * Ticket 11 — what a nested subagent inherits from the host session's resources.
 *
 * The isolation contract isolates the host's *private* machinery: extensions,
 * the skill index, prompt templates, themes, and Pi's own docs block never
 * reach a subagent. Project CONTEXT files (AGENTS.md and friends) do — a
 * subagent working in this repository must follow this repository's rules.
 *
 * These are characterisation tests: the behaviour predates them and is
 * deliberately kept, so they exist to stop it changing silently rather than to
 * drive a fix. If a subagent ever stops seeing AGENTS.md, or starts seeing the
 * docs/skills sections, this file fails.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";

import { createTestSession } from "./harness.ts";

const MARKER = "SUBCONTEXT-MARKER: answer in the project's own dialect.";

interface NestedSystem {
	/** Section keys of the nested system message. */
	keys: string[];
	/** Text of the `project_context` section. */
	projectContext: string;
	/** Text of the `addendum` section (the definition body / instructions). */
	addendum: string;
}

function writeAgent(root: string, name: string, frontmatter: string[] = []): void {
	const dir = join(root, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.md`),
		["---", `description: The ${name} agent`, ...frontmatter, "---", "", `You are ${name}.`, ""].join("\n"),
	);
}

function writeContextFile(root: string): void {
	writeFileSync(join(root, "AGENTS.md"), `# Project context\n\n${MARKER}\n`);
}

function readNestedSystem(context: TranscriptContext): NestedSystem {
	const system = context.messages.find((message) => message.role === "system") as
		| { sections?: Record<string, unknown> }
		| undefined;
	const sections = system?.sections ?? {};
	const text = (key: string): string =>
		typeof sections[key] === "string" ? (sections[key] as string) : JSON.stringify(sections[key] ?? "");
	return {
		keys: Object.keys(sections),
		projectContext: text("project_context"),
		addendum: text("addendum"),
	};
}

/** Host-private resources must never appear; the project context must. */
function expectInheritedShape(nested: NestedSystem): void {
	expect(nested.projectContext).toContain("SUBCONTEXT-MARKER");
	expect(nested.keys).not.toContain("docs");
	expect(nested.keys).not.toContain("skills");
}

it("hands project context files to an ad-hoc delegation", async () => {
	const { session, faux, dispose, root } = await createTestSession();
	try {
		writeContextFile(root);
		let nested: NestedSystem | undefined;

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { instructions: "You are terse.", task: "Say hi" }), {
				stopReason: "toolUse",
			}),
			(context: TranscriptContext) => {
				nested = readNestedSystem(context);
				return fauxAssistantMessage("hi");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate.");

		expect(nested).toBeDefined();
		expectInheritedShape(nested!);
		// The inline instructions still ride the addendum, not the context file.
		expect(nested!.addendum).toContain("You are terse.");
	} finally {
		dispose();
	}
});

it("hands project context files to a named definition", async () => {
	const { session, faux, dispose, root } = await createTestSession();
	try {
		writeContextFile(root);
		writeAgent(root, "reviewer");
		let nested: NestedSystem | undefined;

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { agent: "reviewer", task: "Review it" }), {
				stopReason: "toolUse",
			}),
			(context: TranscriptContext) => {
				nested = readNestedSystem(context);
				return fauxAssistantMessage("reviewed");
			},
			fauxAssistantMessage("Understood."),
		]);

		await session.prompt("Delegate.");

		expectInheritedShape(nested!);
		expect(nested!.addendum).toContain("You are reviewer.");
	} finally {
		dispose();
	}
});

it("hands project context files to a command-started run", async () => {
	const { session, faux, dispose, root } = await createTestSession();
	try {
		writeContextFile(root);
		writeAgent(root, "reviewer");
		let nested: NestedSystem | undefined;

		faux.setResponses([
			(context: TranscriptContext) => {
				nested = readNestedSystem(context);
				return fauxAssistantMessage("reviewed");
			},
		]);

		await session.prompt("/subagents run reviewer Review the changes");

		expectInheritedShape(nested!);
	} finally {
		dispose();
	}
});
