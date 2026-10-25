/**
 * Ticket 09 — managed definitions.
 *
 * The user gets the same control over definitions that the model has through
 * `create_subagent`: scaffold one, edit it, delete it — always against the
 * directory discovery resolved, always validated, always confirmed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { captureStdio, createTestSession, userOutput } from "./harness.ts";

function writeAgent(root: string, file: string, description: string): void {
	const dir = join(root, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), ["---", `description: ${description}`, "---", "", "Body.", ""].join("\n"));
}

it("scaffolds a definition into the project directory", async () => {
	const { session, root, ui, dispose } = await createTestSession();
	try {
		await session.prompt("/subagents new reviewer Reviews code changes");

		const path = join(root, ".pi", "agents", "reviewer.md");
		expect(existsSync(path)).toBe(true);
		const content = readFileSync(path, "utf-8");
		expect(content).toContain("description: Reviews code changes");

		await session.prompt("/subagents");
		expect(userOutput(ui)).toContain("- reviewer — Reviews code changes");
	} finally {
		dispose();
	}
});

it("asks for a missing name and description", async () => {
	const { session, root, dispose } = await createTestSession({
		dialogs: { input: ["scout", "Explores unfamiliar code"] },
	});
	try {
		await session.prompt("/subagents new");

		const path = join(root, ".pi", "agents", "scout.md");
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf-8")).toContain("description: Explores unfamiliar code");
	} finally {
		dispose();
	}
});

it("refuses to overwrite without --force and overwrites with it", async () => {
	const { session, root, ui, dispose } = await createTestSession();
	try {
		writeAgent(root, "reviewer.md", "Original description");

		await session.prompt("/subagents new reviewer Replacement description");
		expect(userOutput(ui)).toMatch(/already exists/i);
		expect(readFileSync(join(root, ".pi", "agents", "reviewer.md"), "utf-8")).toContain("Original description");

		await session.prompt("/subagents new reviewer Replacement description --force");
		expect(readFileSync(join(root, ".pi", "agents", "reviewer.md"), "utf-8")).toContain("Replacement description");
	} finally {
		dispose();
	}
});

it("refuses to scaffold silently in a non-interactive session", async () => {
	const stdio = captureStdio();
	const nonInteractive = await createTestSession({ mode: "print" });
	try {
		await nonInteractive.session.prompt("/subagents new");
		// No hang, no file: an explicit usage error on the diagnostic channel.
		expect(existsSync(join(nonInteractive.root, ".pi", "agents"))).toBe(false);
		expect(stdio.stderr()).toMatch(/usage/i);
	} finally {
		nonInteractive.dispose();
		stdio.restore();
	}
});

it("opens the resolved file for editing and saves valid content only", async () => {
	const { session, root, ui, dispose } = await createTestSession({
		dialogs: {
			editor: [
				["---", "description: Edited description", "---", "", "Edited body.", ""].join("\n"),
				["---", "description:", "---", "", "Broken.", ""].join("\n"),
			],
		},
	});
	try {
		writeAgent(root, "reviewer.md", "Original description");

		await session.prompt("/subagents edit reviewer");
		expect(readFileSync(join(root, ".pi", "agents", "reviewer.md"), "utf-8")).toContain("Edited description");

		// Invalid edits are rejected and the file keeps its last good content.
		await session.prompt("/subagents edit reviewer");
		expect(readFileSync(join(root, ".pi", "agents", "reviewer.md"), "utf-8")).toContain("Edited description");
		expect(userOutput(ui)).toMatch(/not saved|error/i);
	} finally {
		dispose();
	}
});

it("reports the available names when editing an unknown agent", async () => {
	const { session, ui, root, dispose } = await createTestSession();
	try {
		writeAgent(root, "reviewer.md", "Reviews code changes");

		await session.prompt("/subagents edit ghost");

		const output = userOutput(ui);
		expect(output).toMatch(/no agent definition named "ghost"/i);
		expect(output).toContain("reviewer");
	} finally {
		dispose();
	}
});

it("deletes only after a confirmation", async () => {
	const { session, ui, root, dispose } = await createTestSession({ dialogs: { confirm: [false, true] } });
	try {
		const path = join(root, ".pi", "agents", "reviewer.md");
		writeAgent(root, "reviewer.md", "Reviews code changes");

		await session.prompt("/subagents rm reviewer");
		expect(existsSync(path)).toBe(true);
		expect(userOutput(ui)).toMatch(/cancel/i);

		await session.prompt("/subagents rm reviewer");
		expect(existsSync(path)).toBe(false);
		expect(userOutput(ui)).toMatch(/deleted/i);
	} finally {
		dispose();
	}
});

it("refuses to delete in a non-interactive session without --yes", async () => {
	const stdio = captureStdio();
	const { session, root, dispose } = await createTestSession({ mode: "print" });
	try {
		const path = join(root, ".pi", "agents", "reviewer.md");
		writeAgent(root, "reviewer.md", "Reviews code changes");

		await session.prompt("/subagents rm reviewer");
		expect(existsSync(path)).toBe(true);
		expect(stdio.stderr()).toMatch(/--yes|confirm/i);
	} finally {
		dispose();
		stdio.restore();
	}
});

it("deletes a user-level definition from the user directory", async () => {
	const { session, agentDir, dispose } = await createTestSession({ dialogs: { confirm: [true] } });
	try {
		const dir = join(agentDir, "agents");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "shared.md");
		writeFileSync(path, ["---", "description: Shared agent", "---", "", "Body.", ""].join("\n"));

		await session.prompt("/subagents rm shared");

		expect(existsSync(path)).toBe(false);
	} finally {
		dispose();
	}
});
