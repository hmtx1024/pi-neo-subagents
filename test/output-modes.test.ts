/**
 * Output channels and direct-run reporting.
 *
 * `/subagents` must reach the user in every mode (interactive, RPC, print,
 * JSON), and a direct run must report what it did — including usage — instead
 * of silently spending tokens.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";

import { captureStdio, createTestSession, userOutput } from "./harness.ts";

function writeAgent(cwd: string, file: string, description: string): void {
	const agentsDir = join(cwd, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(
		join(agentsDir, file),
		["---", `description: ${description}`, "---", "", "You are a careful reviewer.", ""].join("\n"),
	);
}

it("prints the agent listing to stdout in print mode", async () => {
	const stdio = captureStdio();
	const { session, cwd, dispose } = await createTestSession({ mode: "print" });
	try {
		writeAgent(cwd, "reviewer.md", "Reviews code changes");

		await session.prompt("/subagents");

		expect(stdio.stdout()).toContain("- reviewer — Reviews code changes");
	} finally {
		dispose();
		stdio.restore();
	}
});

it("prints a direct-run result to stdout in print mode", async () => {
	const stdio = captureStdio();
	const { session, faux, ui, cwd, dispose } = await createTestSession({ mode: "print" });
	try {
		writeAgent(cwd, "reviewer.md", "Reviews code changes");
		faux.setResponses([(_context) => fauxAssistantMessage("Printed reply.")]);

		await session.prompt("/subagents run reviewer Review the changes.");

		expect(stdio.stdout()).toContain("Printed reply.");
		// No UI in print mode: nothing recorded, nothing dropped silently.
		expect(userOutput(ui)).toBe("");
	} finally {
		dispose();
		stdio.restore();
	}
});

it("keeps stdout clean for the JSON protocol and reports on stderr instead", async () => {
	const stdio = captureStdio();
	const { session, cwd, dispose } = await createTestSession({ mode: "json" });
	try {
		writeAgent(cwd, "reviewer.md", "Reviews code changes");

		await session.prompt("/subagents");

		// stdout is the JSON event stream: plain text there would corrupt it.
		expect(stdio.stdout()).toBe("");
		expect(stdio.stderr()).toContain("- reviewer — Reviews code changes");
	} finally {
		dispose();
		stdio.restore();
	}
});

it("summarises usage for a direct run", async () => {
	const { session, faux, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer.md", "Reviews code changes");
		faux.setResponses([(_context) => fauxAssistantMessage("Short review.")]);

		await session.prompt("/subagents run reviewer Review the changes.");

		const output = userOutput(ui);
		expect(output).toContain("Short review.");
		expect(output).toMatch(/faux-1/);
		expect(output).toMatch(/tokens/i);
		expect(output).toMatch(/turn/i);
	} finally {
		dispose();
	}
});

it("caps the displayed result and points at a file with the full result", async () => {
	const { session, faux, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer.md", "Reviews code changes");
		const longReply = Array.from({ length: 600 }, () => "lorem ipsum").join(" ");
		faux.setResponses([(_context) => fauxAssistantMessage(longReply)]);

		await session.prompt("/subagents run reviewer Review the changes.");

		const output = userOutput(ui);
		expect(output).not.toContain(longReply);
		expect(output.length).toBeLessThan(4_000);

		const match = /Full result: (.+?)\]/.exec(output);
		expect(match).not.toBeNull();
		expect(readFileSync(match![1].trim(), "utf-8")).toBe(longReply);
	} finally {
		dispose();
	}
});

it("reports progress while a direct run is in flight and clears it afterwards", async () => {
	const { session, faux, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer.md", "Reviews code changes");
		faux.setResponses([(_context) => fauxAssistantMessage("Done.")]);

		await session.prompt("/subagents run reviewer Review the changes.");

		const updates = ui.statuses.filter((status) => status.text !== undefined);
		expect(updates.length).toBeGreaterThanOrEqual(1);
		expect(updates[0].text).toContain("reviewer");
		expect(updates[0].text).toMatch(/turn 1/);
		expect(ui.statuses[ui.statuses.length - 1].text).toBeUndefined();
	} finally {
		dispose();
	}
});
