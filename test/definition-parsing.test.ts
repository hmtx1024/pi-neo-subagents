/**
 * Frontmatter parsing: values users write in YAML style must either work as
 * intended or fail loudly — never silently fall back to a weaker/stronger
 * configuration.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestSession, userOutput } from "./harness.ts";

function writeAgent(cwd: string, file: string, lines: string[]): void {
	const agentsDir = join(cwd, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, file), lines.join("\n"));
}

it("honours a YAML-list tools whitelist instead of falling back to all default tools", async () => {
	const { session, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "yaml-tools.md", [
			"---",
			"description: YAML list style tools",
			"tools:",
			"  - read",
			"  - bash",
			"---",
			"",
			"Body.",
			"",
		]);

		await session.prompt("/subagents yaml-tools");

		const output = userOutput(ui);
		expect(output).toContain("Tools: read, bash");
		expect(output).not.toContain("all default");
	} finally {
		dispose();
	}
});

it("strips quotes and trailing comments from frontmatter values", async () => {
	const { session, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "quoted.md", [
			"---",
			'description: "Quoted description"',
			"---",
			"",
			"Body.",
			"",
		]);
		writeAgent(cwd, "commented.md", ["---", "description: Plain text # a note", "---", "", "Body.", ""]);

		await session.prompt("/subagents");

		const output = userOutput(ui);
		expect(output).toContain("- quoted — Quoted description");
		expect(output).not.toContain('"Quoted description"');
		expect(output).toContain("- commented — Plain text");
		expect(output).not.toContain("a note");
	} finally {
		dispose();
	}
});

it("reports an error for an unterminated quoted value", async () => {
	const { session, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "broken-quote.md", ["---", 'description: "unterminated', "---", "", "Body.", ""]);

		await session.prompt("/subagents");

		const errors = ui.notifications.filter((notification) => notification.type === "error");
		expect(errors.map((notification) => notification.message).join("\n")).toContain("broken-quote.md");
		expect(errors.map((notification) => notification.message).join("\n")).toMatch(/quote/i);
	} finally {
		dispose();
	}
});

it("reports an error when tools is present but empty", async () => {
	const { session, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "empty-tools.md", [
			"---",
			"description: Empty tools key",
			"tools:",
			"---",
			"",
			"Body.",
			"",
		]);

		await session.prompt("/subagents");

		const errors = ui.notifications
			.filter((notification) => notification.type === "error")
			.map((notification) => notification.message)
			.join("\n");
		expect(errors).toContain("empty-tools.md");
		expect(errors).toMatch(/tools/);
		expect(userOutput(ui)).not.toContain("- empty-tools —");
	} finally {
		dispose();
	}
});

it("accepts skills as a comma list and as the all wildcard", async () => {
	const { session, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "skilled.md", [
			"---",
			"description: Uses two skills",
			"skills: code-review, tdd",
			"---",
			"",
			"Body.",
			"",
		]);
		writeAgent(cwd, "wildcard.md", ["---", "description: Uses every skill", "skills: all", "---", "", "Body.", ""]);

		await session.prompt("/subagents");

		const errors = ui.notifications.filter((notification) => notification.type === "error");
		expect(errors).toHaveLength(0);
		const listing = userOutput(ui);
		expect(listing).toContain("skilled");
		expect(listing).toContain("wildcard");

		await session.prompt("/subagents skilled");
		const detail = userOutput(ui);
		expect(detail).toContain("Skills: code-review, tdd");
	} finally {
		dispose();
	}
});

it("reports an error when skills is present but empty", async () => {
	const { session, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "empty-skills.md", ["---", "description: Empty skills key", "skills:", "---", "", "Body.", ""]);

		await session.prompt("/subagents");

		const errors = ui.notifications
			.filter((notification) => notification.type === "error")
			.map((notification) => notification.message)
			.join("\n");
		expect(errors).toContain("empty-skills.md");
		expect(errors).toMatch(/skills/);
		expect(userOutput(ui)).not.toContain("- empty-skills —");
	} finally {
		dispose();
	}
});

it("reports an error when skills mixes all with concrete names", async () => {
	const { session, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "mixed-skills.md", [
			"---",
			"description: all plus a name",
			"skills: all, code-review",
			"---",
			"",
			"Body.",
			"",
		]);

		await session.prompt("/subagents");

		const errors = ui.notifications
			.filter((notification) => notification.type === "error")
			.map((notification) => notification.message)
			.join("\n");
		expect(errors).toContain("mixed-skills.md");
		expect(errors).toMatch(/not both/);
		expect(userOutput(ui)).not.toContain("- mixed-skills —");
	} finally {
		dispose();
	}
});

it("reports a duplicate agent name instead of listing both definitions", async () => {
	const { session, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "dup-a.md", ["---", "name: shadow", "description: First definition", "---", "", "A.", ""]);
		writeAgent(cwd, "dup-b.md", ["---", "name: shadow", "description: Second definition", "---", "", "B.", ""]);

		await session.prompt("/subagents");

		const errors = ui.notifications
			.filter((notification) => notification.type === "error")
			.map((notification) => notification.message)
			.join("\n");
		expect(errors).toContain("shadow");
		expect(errors).toContain("dup-b.md");

		const listing = userOutput(ui);
		expect(listing.match(/- shadow —/g) ?? []).toHaveLength(1);
		expect(listing).toContain("First definition");
		expect(listing).not.toContain("Second definition");
	} finally {
		dispose();
	}
});
