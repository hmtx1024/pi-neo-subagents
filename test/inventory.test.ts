/**
 * Ticket 02 — agent inventory.
 *
 * Spec-level behaviour: agent definitions (Markdown + frontmatter) are
 * discovered from the project-level resource directory and listed by the
 * `/subagents` command with their declared metadata.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";

import { createTestSession, userOutput } from "./harness.ts";

it("lists a project-level agent definition with its name and description", async () => {
	const { session, faux, cwd, ui, dispose } = await createTestSession();
	try {
		const agentsDir = join(cwd, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			["---", "description: Reviews code changes", "---", "", "You are a careful code reviewer.", ""].join("\n"),
		);
		// Only used if the input wrongly falls through to the model.
		faux.setResponses([fauxAssistantMessage("ok")]);

		await session.prompt("/subagents");

		const output = userOutput(ui);
		expect(output).toContain("reviewer");
		expect(output).toContain("Reviews code changes");
	} finally {
		dispose();
	}
});

it("lists every agent with its declared name, tools, and model, and default markers when omitted", async () => {
	const { session, faux, cwd, ui, dispose } = await createTestSession();
	try {
		const agentsDir = join(cwd, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "scout.md"),
			[
				"---",
				"name: scout-lead",
				"description: Explores the codebase",
				"tools: read, grep",
				"model: faux-1",
				"---",
				"",
				"You explore codebases.",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(agentsDir, "helper.md"),
			["---", "description: General helper", "---", "", "You help out.", ""].join("\n"),
		);
		faux.setResponses([fauxAssistantMessage("ok")]);

		await session.prompt("/subagents");

		const output = userOutput(ui);
		expect(output).toContain("scout-lead");
		expect(output).toContain("read, grep");
		expect(output).toContain("faux-1");
		expect(output).toMatch(/all default/i);
		expect(output).toMatch(/inherit/i);
	} finally {
		dispose();
	}
});

it("discovers user-level definitions, with project-level ones overriding them and labelled", async () => {
	const { session, faux, cwd, agentDir, ui, dispose } = await createTestSession();
	try {
		const userAgentsDir = join(agentDir, "agents");
		mkdirSync(userAgentsDir, { recursive: true });
		writeFileSync(
			join(userAgentsDir, "helper.md"),
			["---", "description: User helper", "---", "", "You help out.", ""].join("\n"),
		);
		writeFileSync(
			join(userAgentsDir, "globetrotter.md"),
			["---", "description: Travels the world", "---", "", "You travel.", ""].join("\n"),
		);
		const projectAgentsDir = join(cwd, ".pi", "agents");
		mkdirSync(projectAgentsDir, { recursive: true });
		writeFileSync(
			join(projectAgentsDir, "helper.md"),
			["---", "description: Project helper", "---", "", "You help with this project.", ""].join("\n"),
		);
		faux.setResponses([fauxAssistantMessage("ok")]);

		await session.prompt("/subagents");

		const output = userOutput(ui);
		expect(output).toContain("globetrotter");
		expect(output).toContain("Project helper");
		expect(output).not.toContain("User helper");
		expect(output).toMatch(/override/i);
	} finally {
		dispose();
	}
});

it("shows one agent's full definition via /subagents <name>", async () => {
	const { session, faux, cwd, ui, dispose } = await createTestSession();
	try {
		const agentsDir = join(cwd, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			[
				"---",
				"description: Reviews code changes",
				"tools: read, grep",
				"model: faux-1",
				"---",
				"",
				"You are a careful code reviewer. Always cite the file you reviewed.",
				"",
			].join("\n"),
		);
		faux.setResponses([fauxAssistantMessage("ok")]);

		await session.prompt("/subagents reviewer");

		const output = userOutput(ui);
		expect(output).toContain("You are a careful code reviewer. Always cite the file you reviewed.");
		expect(output).toContain("Reviews code changes");
		expect(output).toContain("read, grep");
		expect(output).toContain("faux-1");

		await session.prompt("/subagents nobody");
		expect(userOutput(ui)).toMatch(/no agent definition named/i);
	} finally {
		dispose();
	}
});

it("reports malformed definitions with file-specific errors instead of listing them", async () => {
	const { session, faux, cwd, ui, dispose } = await createTestSession();
	try {
		const agentsDir = join(cwd, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, "broken.md"), "---\ndescription: Something\n\nNever closed.\n");
		writeFileSync(
			join(agentsDir, "nodesc.md"),
			["---", "name: nodesc", "---", "", "No description field.", ""].join("\n"),
		);
		faux.setResponses([fauxAssistantMessage("ok")]);

		await session.prompt("/subagents");

		const output = userOutput(ui);
		expect(output).toContain("broken.md");
		expect(output).toMatch(/frontmatter/i);
		expect(output).toContain("nodesc.md");
		expect(output).toMatch(/description/i);
		expect(output).not.toContain("- broken ");
		expect(output).not.toContain("- nodesc ");
	} finally {
		dispose();
	}
});
