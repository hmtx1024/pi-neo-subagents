/**
 * `/subagents run` argument parsing: options are parsed strictly and never
 * rewrite the task text the user typed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/compat";

import { createTestSession, userOutput } from "./harness.ts";

function writeAgent(cwd: string, file: string, name: string | undefined, description: string): void {
	const agentsDir = join(cwd, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	const lines = ["---", ...(name ? [`name: ${name}`] : []), `description: ${description}`, "---", "", "Body.", ""];
	writeFileSync(join(agentsDir, file), lines.join("\n"));
}

function captureTurn(captured: string[]): FauxResponseFactory {
	return (context: TranscriptContext) => {
		captured.push(JSON.stringify(context.messages));
		return fauxAssistantMessage("ok");
	};
}

it("keeps --to-context inside the task text and does not send the result into the context", async () => {
	const { session, faux, cwd, ui, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer.md", undefined, "Reviews code changes");

		const subagentSaw: string[] = [];
		const hostSaw: string[] = [];
		faux.setResponses([
			(context) => {
				subagentSaw.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("Delegated reply.");
			},
			captureTurn(hostSaw),
		]);

		await session.prompt("/subagents run reviewer Explain what the --to-context flag does.");
		expect(userOutput(ui)).toContain("Delegated reply.");
		expect(subagentSaw.join("\n")).toContain("--to-context");

		await session.prompt("Next prompt.");

		expect(hostSaw.join("\n")).not.toContain("Delegated reply.");
	} finally {
		dispose();
	}
});

it("treats everything after -- as name and task text", async () => {
	const { session, faux, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer.md", undefined, "Reviews code changes");

		const subagentSaw: string[] = [];
		faux.setResponses([
			(context) => {
				subagentSaw.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("ok");
			},
		]);

		await session.prompt("/subagents run -- reviewer --to-context is just text here");

		expect(subagentSaw.join("\n")).toContain("--to-context is just text here");
	} finally {
		dispose();
	}
});

it("rejects an unknown option with usage instead of guessing", async () => {
	const { session, ui, cwd, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "reviewer.md", undefined, "Reviews code changes");

		await session.prompt("/subagents run --bogus reviewer Do the thing.");

		const errors = ui.notifications
			.filter((notification) => notification.type === "error")
			.map((notification) => notification.message)
			.join("\n");
		expect(errors).toContain("--bogus");
		expect(errors).toContain("Usage:");
	} finally {
		dispose();
	}
});

it("accepts a quoted agent name that contains spaces", async () => {
	const { session, faux, cwd, ui, dispose } = await createTestSession();
	try {
		writeAgent(cwd, "code review.md", undefined, "Reviews code with a spaced name");
		faux.setResponses([(_context) => fauxAssistantMessage("Spaced agent reply.")]);

		await session.prompt('/subagents run "code review" Review hello.ts');

		expect(userOutput(ui)).toContain("Spaced agent reply.");
	} finally {
		dispose();
	}
});
